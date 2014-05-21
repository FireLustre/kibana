define(function (require) {
  var _ = require('utils/mixins');
  var angular = require('angular');
  var moment = require('moment');
  var settingsHtml = require('text!../partials/settings.html');
  var saveHtml = require('text!../partials/save_search.html');
  var loadHtml = require('text!../partials/load_search.html');

  var interval = require('utils/interval');
  var datemath = require('utils/datemath');

  require('notify/notify');
  require('directives/timepicker');
  require('directives/fixed_scroll');
  require('filters/moment');
  require('courier/courier');
  require('state_management/app_state');
  require('services/timefilter');

  require('apps/visualize/saved_visualizations/_adhoc_vis');

  var app = require('modules').get('app/discover', [
    'kibana/services',
    'kibana/notify',
    'kibana/courier'
  ]);

  require('routes')
  .when('/discover/:id?', {
    templateUrl: 'kibana/apps/discover/index.html',
    reloadOnSearch: false,
    resolve: {
      savedSearch: function (savedSearches, $route, $location, Notifier, courier) {
        return savedSearches.get($route.current.params.id)
        .catch(courier.redirectWhenMissing('/discover'));
      },
      indexPatternList: function (courier) {
        return courier.indexPatterns.getIds()
        .then(courier.indexPatterns.ensureSome());
      }
    }
  });


  app.controller('discover', function ($scope, config, courier, $route, savedSearches, savedVisualizations,
    Notifier, $location, globalState, AppState, timefilter, AdhocVis, Promise) {

    var notify = new Notifier({
      location: 'Discover'
    });

    // the saved savedSearch
    var savedSearch = $route.current.locals.savedSearch;
    $scope.$on('$destroy', savedSearch.destroy);

    // list of indexPattern id's
    var indexPatternList = $route.current.locals.indexPatternList;

    // the actual courier.SearchSource
    var searchSource = savedSearch.searchSource;

    // Manage state & url state
    var initialQuery = searchSource.get('query');

    var stateDefaults = {
      query: initialQuery ? initialQuery.query_string.query : '',
      columns: ['_source'],
      sort: ['_score', 'desc'],
      index: config.get('defaultIndex'),
    };

    var $state = $scope.state = new AppState(stateDefaults);

    if (!_.contains(indexPatternList, $state.index)) {
      var reason = 'The index specified in the URL is not a configured pattern. ';
      var defaultIndex = config.get('defaultIndex');
      if (defaultIndex) {
        notify.warning(reason + 'Updated it to use the default: "' + defaultIndex + '"');
        $state.index = config.get('defaultIndex');
      } else {
        notify.warning(reason + 'Please set a default index to continue.');
        $location.url('/settings/indices');
        return;
      }
    }

    $scope.opts = {
      // number of records to fetch, then paginate through
      sampleSize: 500,
      // max length for summaries in the table
      maxSummaryLength: 100,
      // Index to match
      index: $state.index,
      savedSearch: savedSearch,
      indexPatternList: indexPatternList,
    };

    // So we can watch it.
    $scope.time = timefilter.time;

    // stores the complete list of fields
    $scope.fields = null;

    var init = _.once(function () {
      return setFields()
      .then(function () {
        updateDataSource();

        // state fields that shouldn't trigger a fetch when changed
        var ignoreStateChanges = ['columns'];

        // listen for changes, and relisten everytime something happens
        $state.onUpdate(function (changed) {
          // if we only have ignorable changes, do nothing
          if (_.difference(changed, ignoreStateChanges).length) $scope.fetch();
        });

        // TODO: Switch this to watching time.string when we implement it
        $scope.$watchCollection('time', function (newTime, oldTime) {
          // don't fetch unless there was a previous value and the values are not loosly equal
          if (!_.isUndefined(oldTime) && !angular.equal(newTime, oldTime)) $scope.fetch();
        });

        $scope.$watch('state.sort', function (sort) {
          if (!sort) return;

          // get the current sort from {key: val} to ["key", "val"];
          var currentSort = _.pairs(searchSource.get('sort')).pop();

          // if the searchSource doesn't know, tell it so
          if (!angular.equals(sort, currentSort)) $scope.fetch();
        });

        searchSource.onError().then(function searchError(err) {
          console.log(err);
          notify.error('An error occured with your request. Reset your inputs and try again.');

          return searchSource.onError().then(searchError);
        });

        // Bind a result handler. Any time searchSource.fetch() is executed this gets called
        // with the results
        searchSource.onResults().then(function onResults(resp) {
          var complete = notify.event('on results');
          $scope.hits = resp.hits.total;
          $scope.rows = resp.hits.hits;
          $scope.rows.forEach(function (hit) {
            hit._formatted = _.mapValues(hit._source, function (value, name) {
              return $scope.formatsByName[name].convert(value);
            });
            hit._formatted._source = angular.toJson(hit._source);
          });

          complete();
          return searchSource.onResults().then(onResults);
        }).catch(function (err) {
          console.log('An error', err);
        });

        return setupVisualization().then(function () {
          $scope.$emit('application.load');
        });
      });
    });

    $scope.opts.saveDataSource = function () {
      updateDataSource();
      savedSearch.id = savedSearch.title;

      savedSearch.save()
      .then(function () {
        notify.info('Saved Data Source "' + savedSearch.title + '"');
        if (savedSearch.id !== $route.current.params.id) {
          $location.url(globalState.writeToUrl('/discover/' + savedSearch.id));
        }
      }, notify.error);
    };

    $scope.fetch = function () {
      setupVisualization().then(function () {
        if ($scope.opts.timefield) timefilter.enabled(true);

        updateDataSource();
        $state.commit();

        courier.fetch();
      }, notify.error);
    };

    $scope.toggleConfig = function () {
      // Close if already open
      if ($scope.configTemplate === settingsHtml) {
        delete $scope.configTemplate;
      } else {
        $scope.configTemplate = settingsHtml;
      }
    };

    $scope.toggleSave = function () {
      // Close if already open
      if ($scope.configTemplate === saveHtml) {
        delete $scope.configTemplate;
      } else {
        $scope.configTemplate = saveHtml;
      }
    };

    $scope.toggleLoad = function () {
      // Close if already open
      if ($scope.configTemplate === loadHtml) {
        delete $scope.configTemplate;
      } else {
        $scope.configTemplate = loadHtml;
      }
    };

    $scope.resetQuery = function () {
      $state.query = stateDefaults.query;
      $state.sort = stateDefaults.sort;
      $state.columns = stateDefaults.columns;
      $scope.fetch();
    };

    function updateDataSource() {
      var chartOptions;

      searchSource
        .size($scope.opts.sampleSize)
        .sort(_.zipObject([$state.sort]))
        .query(!$scope.state.query ? null : {
          query_string: {
            query: $scope.state.query
          }
        });

      if ($scope.opts.index !== searchSource.get('index')) {
        // set the index on the savedSearch
        searchSource.index($scope.opts.index);

        $state.index = $scope.opts.index;
        delete $scope.fields;
        delete $scope.columns;

        setFields();
      }
    }

    // This is a hacky optimization for comparing the contents of a large array to a short one.
    function arrayToKeys(array, value) {
      var obj = {};
      _.each(array, function (key) {
        obj[key] = value || true;
      });
      return obj;
    }

    function setFields() {
      return courier.getFieldsFor($scope.opts.index)
      .then(function (rawFields) {
        var currentState = _.transform($scope.fields || [], function (current, field) {
          current[field.name] = {
            display: field.display
          };
        }, {});

        if (!rawFields) return;

        var columnObjects = arrayToKeys($scope.state.columns);

        $scope.fields = [];
        $scope.fieldsByName = {};
        $scope.formatsByName = {};
        $scope.state.columns = $scope.state.columns || [];

        // Inject source into list;
        $scope.fields.push({name: '_source', type: 'source', display: false});

        _.sortBy(rawFields, 'name').forEach(function (field) {
          _.defaults(field, currentState[field.name]);
          // clone the field and add it's display prop
          var clone = _.assign({}, field, { display: columnObjects[name] || false });
          $scope.fields.push(clone);
          $scope.fieldsByName[field.name] = clone;
          $scope.formatsByName[field.name] = field.format;
        });

        // TODO: timefield should be associated with the index pattern, this is a hack
        // to pick the first date field and use it.
        var timefields = _.find($scope.fields, {type: 'date'});
        if (!!timefields) {
          $scope.opts.timefield = timefields.name;
        } else {
          delete $scope.opts.timefield;
        }

        refreshColumns();
      }, notify.error);
    }

    // TODO: On array fields, negating does not negate the combination, rather all terms
    $scope.filterQuery = function (field, value, operation) {
      value = _.isArray(value) ? value : [value];
      operation = operation || '+';

      _.each(value, function (clause) {
        var filter = field + ':"' + addSlashes(clause) + '"';
        var regex = '[\\+-]' + regexEscape(filter) + '\\s*';

        $scope.state.query = $scope.state.query.replace(new RegExp(regex), '') +
          ' ' + operation + filter;
      });

      $scope.fetch();
    };

    $scope.toggleField = function (name) {
      var field = _.find($scope.fields, { name: name });

      // toggle the display property
      field.display = !field.display;

      if ($scope.state.columns.length === 1 && $scope.state.columns[0] === '_source') {
        $scope.state.columns = _.toggleInOut($scope.state.columns, name);
        $scope.state.columns = _.toggleInOut($scope.state.columns, '_source');
        _.find($scope.fields, {name: '_source'}).display = false;

      } else {
        $scope.state.columns = _.toggleInOut($scope.state.columns, name);
      }

      refreshColumns();
    };

    function refreshColumns() {
      // Get all displayed field names;
      var fields = _.pluck(_.filter($scope.fields, function (field) {
        return field.display;
      }), 'name');

      // Make sure there are no columns added that aren't in the displayed field list.
      $scope.state.columns = _.intersection($scope.state.columns, fields);

      // If no columns remain, use _source
      if (!$scope.state.columns.length) {
        $scope.toggleField('_source');
        return;
      }

      // if this commit results in something besides the columns changing, a fetch will be executed.
      $state.commit();
    }

    // TODO: Move to utility class
    var addSlashes = function (str) {
      if (!_.isString(str)) return str;
      str = str.replace(/\\/g, '\\\\');
      str = str.replace(/\'/g, '\\\'');
      str = str.replace(/\"/g, '\\"');
      str = str.replace(/\0/g, '\\0');
      return str;
    };

    // TODO: Move to utility class
    // https://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
    var regexEscape = function (str) {
      return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    };

    var setupVisualization = function () {
      return new Promise(function (resolve, reject) {
        // we shouldn't have a vis, delete it
        if (!$scope.opts.timefield && $scope.vis) delete $scope.vis;
        // we shouldn't have one, or already do, return whatever we already have
        if (!$scope.opts.timefield || $scope.vis) return resolve($scope.vis);

        // set the scopes vis property to the AdhocVis so that we know not to re-init
        $scope.vis = new AdhocVis({
          searchSource: searchSource,
          type: 'histogram',
          listeners: {
            onClick: function (e) {
              console.log(e);
            }
          },
          config: {
            metric: {
              configs: [{
                agg: 'count',
              }]
            },
            segment: {
              configs: [{
                agg: 'date_histogram',
                field: $scope.opts.timefield,
                min_doc_count: 0,
              }]
            },
            group: { configs: [] },
            split: { configs: [] },
          }
        });

        // once the visualization is ready, resolve the promise with the vis
        $scope.$on('ready:vis', function () {
          // enable the source, but wait for the visualization to be ready before running
          resolve($scope.vis);
        });
      });
    };

    init();
  });
});