/* global require, module, escape */
'use strict';

/**
@module ember-cli
*/
var fs           = require('fs');
var existsSync   = require('exists-sync');
var path         = require('path');
var p            = require('../preprocessors');
var chalk        = require('chalk');
var escapeRegExp = require('escape-string-regexp');
var EOL          = require('os').EOL;

var Project      = require('../models/project');
var cleanBaseURL = require('clean-base-url');
var SilentError  = require('silent-error');

var preprocessJs  = p.preprocessJs;
var preprocessCss = p.preprocessCss;
var isType        = p.isType;

var preprocessTemplates = p.preprocessTemplates;

var preprocessMinifyCss = p.preprocessMinifyCss;

var ES6Modules  = require('broccoli-es6modules');
var concatFilesWithSourcemaps = require('broccoli-sourcemap-concat');

var configLoader        = require('./broccoli-config-loader');
var configReplace       = require('./broccoli-config-replace');
var upstreamMergeTrees  = require('broccoli-merge-trees');

var unwatchedTree    = require('broccoli-unwatched-tree');

var defaults      = require('lodash/object/defaults');
var merge         = require('lodash/object/merge');
var omit          = require('lodash/object/omit');
var path          = require('path');
var ES3SafeFilter = require('broccoli-es3-safe-recast');
var Funnel        = require('broccoli-funnel');

function mergeTrees(inputTree, options) {
  var tree = upstreamMergeTrees(inputTree, options);

  tree.description = options && options.description;

  return tree;
}

module.exports = EmberApp;

/**
  EmberApp is the main class Ember CLI uses to manage the Brocolli trees
  for your application. It is very tightly integrated with Brocolli and has
  an `toTree()` method you can use to get the entire tree for your application.

  Available init options:
    - es3Safe, defaults to `true`,
    - storeConfigInMeta, defaults to `true`,
    - autoRun, defaults to `true`,
    - outputPaths, defaults to `{}`,
    - minifyCSS, defaults to `{enabled: !!isProduction,options: { relativeTo: 'app/styles' }},
    - minifyJS, defaults to `{enabled: !!isProduction},
    - loader, defaults to this.bowerDirectory + '/loader.js/loader.js',
    - sourcemaps, defaults to `{}`,
    - trees, defaults to `{},`
    - jshintrc, defaults to `{},`
    - vendorFiles, defaults to `{}`

  @class EmberApp
  @constructor
  @param {Object} options Configuration options
*/
function EmberApp(options) {
  options = options || {};

  this._initProject(options);

  this.env  = EmberApp.env();
  this.name = options.name || this.project.name();

  this.registry = options.registry || p.defaultRegistry(this);

  this.bowerDirectory = this.project.bowerDirectory;

  var isProduction = this.env === 'production';

  this._initTestsAndHinting(options, isProduction);
  this._initOptions(options, isProduction);
  this._initVendorFiles();

  this.legacyFilesToAppend     = [];
  this.vendorStaticStyles      = [];
  this.otherAssetPaths         = [];
  this._importTrees            = [];
  this.legacyTestFilesToAppend = [];
  this.vendorTestStaticStyles  = [];

  this.trees = this.options.trees;

  this.populateLegacyFiles();
  p.setupRegistry(this);
  this._notifyAddonIncluded();
}

/**
  @private
  @method _initTestsAndHinting
  @param {Object} options
  @param {Boolean} isProduction
*/
EmberApp.prototype._initTestsAndHinting = function(options, isProduction) {
  var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;

  this.tests   = options.hasOwnProperty('tests')   ? options.tests   : testsEnabledDefault;
  this.hinting = options.hasOwnProperty('hinting') ? options.hinting : testsEnabledDefault;
};

/**
  @private
  @method _initProject
  @param {Object} options
*/
EmberApp.prototype._initProject = function(options) {
  this.project = options.project || Project.closestSync(process.cwd());

  if (options.configPath) {
    this.project.configPath = function() { return options.configPath; };
  }
};

/**
  @private
  @method _initOptions
  @param {Object} options
  @param {Boolean} isProduction
*/
EmberApp.prototype._initOptions = function(options, isProduction) {
  this.options = merge(options, {
    es3Safe: true,
    storeConfigInMeta: true,
    autoRun: true,
    outputPaths: {},
    minifyCSS: {
      enabled: !!isProduction,
      options: { relativeTo: 'app/styles' }
    },
    minifyJS: {
      enabled: !!isProduction,
    },
    loader: this.bowerDirectory + '/loader.js/loader.js',
    sourcemaps: {},
    trees: {},
    jshintrc: {},
    'ember-cli-qunit': {
      disableContainerStyles: false
    }
  }, defaults);

  // needs a deeper merge than is provided above
  this.options.outputPaths = merge(this.options.outputPaths, {
    app: {
      html: 'index.html',
      css: {
        'app': '/assets/' + this.name + '.css'
      },
      js: '/assets/' + this.name + '.js'
    },
    vendor: {
      css: '/assets/vendor.css',
      js: '/assets/vendor.js'
    },
    testSupport: {
      css: '/assets/test-support.css',
      js: {
        testSupport: '/assets/test-support.js',
        testLoader: '/assets/test-loader.js'
      }
    }
  }, defaults);

  this.options.sourcemaps = merge(this.options.sourcemaps, {
    enabled: !isProduction,
    extensions: ['js']
  }, defaults);

  this.options.trees = merge(this.options.trees, {
    app:       'app',
    tests:     'tests',

    // these are contained within app/ no need to watch again
    styles:    unwatchedTree('app/styles'),
    templates: existsSync('app/templates') ? unwatchedTree('app/templates') : null,

    // do not watch vendor/ or bower's default directory by default
    bower: unwatchedTree(this.bowerDirectory),
    vendor: existsSync('vendor') ? unwatchedTree('vendor') : null,

    public: existsSync('public') ? 'public' : null
  }, defaults);

  this.options.jshintrc = merge(this.options.jshintrc, {
    app: this.project.root,
    tests: path.join(this.project.root, 'tests'),
  }, defaults);
};

/**
  @private
  @method _initVendorFiles
*/
EmberApp.prototype._initVendorFiles = function() {
  // in Ember 1.10 and higher `ember.js` is deprecated in favor of
  // the more aptly named `ember.debug.js`.
  var defaultDevelopmentEmber = this.bowerDirectory + '/ember/ember.debug.js';
  if (!existsSync(path.join(this.project.root, defaultDevelopmentEmber))) {
    defaultDevelopmentEmber = this.bowerDirectory + '/ember/ember.js';
  }

  var handlebarsVendorFiles;
  if ('handlebars' in this.project.bowerDependencies()) {
    handlebarsVendorFiles = {
      development: this.bowerDirectory + '/handlebars/handlebars.js',
      production:  this.bowerDirectory + '/handlebars/handlebars.runtime.js'
    };
  } else {
    handlebarsVendorFiles = null;
  }

  this.vendorFiles = omit(merge({
    'loader.js': this.options.loader,
    'jquery.js': this.bowerDirectory + '/jquery/dist/jquery.js',
    'handlebars.js': handlebarsVendorFiles,
    'ember.js': {
      development: defaultDevelopmentEmber,
      production:  this.bowerDirectory + '/ember/ember.prod.js'
    },
    'ember-testing.js': [
      this.bowerDirectory + '/ember/ember-testing.js',
      { type: 'test' }
    ],
    'app-shims.js': [
      this.bowerDirectory + '/ember-cli-shims/app-shims.js', {
        exports: {
          ember: ['default']
        }
      }
    ],
    'ember-resolver.js': [
      this.bowerDirectory + '/ember-resolver/dist/modules/ember-resolver.js', {
        exports: {
          'ember/resolver': ['default']
        }
      }
    ],
    'ember-load-initializers.js': [
      this.bowerDirectory + '/ember-load-initializers/ember-load-initializers.js', {
        exports: {
          'ember/load-initializers': ['default']
        }
      }
    ]
  }, this.options.vendorFiles), function(value) {
    return value === null;
  });

  // this is needed to support versions of Ember older than
  // 1.8.0 (when ember-testing.js was added to the deployment)
  if (!existsSync(this.vendorFiles['ember-testing.js'][0])) {
    delete this.vendorFiles['ember-testing.js'];
  }
};

/**
  Returns the environment name

  @public
  @static
  @method env
  @return {String} Environment name
 */
EmberApp.env = function(){
  return process.env.EMBER_ENV || 'development';
};

/**
  Provides a broccoli files concatenation filter that's configured
  properly for this application.

  @method concatFiles
  @param tree
  @param options
  @return
*/
EmberApp.prototype.concatFiles = function(tree, options) {
  options.sourceMapConfig = this.options.sourcemaps;

  return concatFilesWithSourcemaps(tree, options);
};


/**
  @private
  @method _notifyAddonIncluded
*/
EmberApp.prototype._notifyAddonIncluded = function() {
  this.initializeAddons();
  this.project.addons = this.project.addons.filter(function(addon) {
    addon.app = this;

    if (!addon.isEnabled || addon.isEnabled()) {
      if (addon.included) {
        addon.included(this);
      }

      return addon;
    }
  }, this);
};

/**
  Loads and initializes addons for this project.
  Calls initializeAddons on the Project.

  @private
  @method initializeAddons
*/
EmberApp.prototype.initializeAddons = function() {
  this.project.initializeAddons();
};

/**
  Returns a list of trees for a given type, returned by all addons.

  @private
  @method addonTreesFor
  @param  {String} type Type of tree
  @return {Array}       List of trees
 */
EmberApp.prototype.addonTreesFor = function(type) {
  return this.project.addons.map(function(addon) {
    if (addon.treeFor) {
      return addon.treeFor(type);
    }
  }, this).filter(Boolean);
};

/**
  Runs addon postprocessing on a given tree and returns the processed tree.

  This enables addons to do process immediately **after** the preprocessor for a
  given type is run, but before concatenation occurs. If an addon wishes to
  apply a transform before the preprocessors run, they can instead implement the
  preprocessTree hook.

  To utilize this addons implement `postprocessTree` hook.

  An example, would be to apply some broccoli transform on all JS files, but
  only after the existing pre-processors have fun.

  ```js
  module.exports = {
    name: 'my-cool-addon',
    postprocessTree: function(type, tree) {
      if (type === 'js') {
        return someBroccoliTransform(tree);
      }

      return tree;
    }
  }

  ```

  @private
  @method addonPostprocessTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonPostprocessTree = function(type, tree) {
  var workingTree = tree;

  this.project.addons.forEach(function(addon) {
    if (addon.postprocessTree) {
      workingTree = addon.postprocessTree(type, workingTree);
    }
  });

  return workingTree;
};


/**
  Runs addon postprocessing on a given tree and returns the processed tree.

  This enables addons to do process immediately **before** the preprocessor for a
  given type is run, but before concatenation occurs.  If an addon wishes to
  apply a transform  after the preprocessors run, they can instead implement the
  postprocessTree hoo.

  To utilize this addons implement `postprocessTree` hook.

  An example, would be to remove some set of files before the preprocessors run.

  ```js
  var stew = require('broccoli-stew');

  module.exports = {
    name: 'my-cool-addon',
    preprocessTree: function(type, tree) {
      if (type === 'js' && type === 'template') {
        return stew.rm(tree, someGlobPattern);
      }

      return tree;
    }
  }
  ```

  @private
  @method addonPreprocessTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonPreprocessTree = function(type, tree) {
  var workingTree = tree;

  this.project.addons.forEach(function(addon) {
    if (addon.preprocessTree) {
      workingTree = addon.preprocessTree(type, workingTree);
    }
  });

  return workingTree;
};

/**
  Runs addon lintTree hooks and returns a single tree containing all
  their output.

  @private
  @method addonLintTree
  @param  {String} type Type of tree
  @param  {Tree}   tree Tree to process
  @return {Tree}        Processed tree
 */
EmberApp.prototype.addonLintTree = function(type, tree) {
  var output = [];
  this.project.addons.forEach(function(addon) {
    if (addon.lintTree) {
      output.push(addon.lintTree(type, tree));
    }
  });
  return mergeTrees(output,{
    overwrite: true,
    description: 'TreeMerger (lint)'
  });
};

/**
  Imports legacy imports in this.vendorFiles

  @private
  @method populateLegacyFiles
*/
EmberApp.prototype.populateLegacyFiles = function () {
  var name;
  for (name in this.vendorFiles) {
    var args = this.vendorFiles[name];

    if (args === null) { continue; }

    this.import.apply(this, [].concat(args));
  }
};

/**
  Returns the tree for app/index.html

  @private
  @method index
  @return {Tree} Tree for app/index.html
*/
EmberApp.prototype.index = function() {
  var htmlName = this.options.outputPaths.app.html;
  var files = [
    'index.html'
  ];

  var index = new Funnel(this.trees.app, {
    files: files,
    getDestinationPath: function(relativePath) {
      if (relativePath === 'index.html') {
        relativePath = htmlName;
      }
      return relativePath;
    },
    description: 'Funnel: index.html'
  });

  return configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: [ htmlName ],
    patterns: this._configReplacePatterns()
  });
};

/**
  @private
  @method _filterAppTree
  @return tree
*/
EmberApp.prototype._filterAppTree = function() {
  if (this._cachedFilterAppTree) {
    return this._cachedFilterAppTree;
  }

  var podPatterns = this._podTemplatePatterns();
  var excludePatterns = podPatterns.concat([
    // note: do not use path.sep here Funnel uses
    // walk-sync which always joins with `/` (not path.sep)
    new RegExp('^styles/'),
    new RegExp('^templates/'),
  ]);

  return this._cachedFilterAppTree = new Funnel(this.trees.app, {
    exclude: excludePatterns,
    description: 'Funnel: Filtered App'
  });
};

/**
  @private
  @method _configReplacePatterns
  @return
*/
EmberApp.prototype._configReplacePatterns = function() {
  return [{
    match: /\{\{EMBER_ENV\}\}/g,
    replacement: calculateEmberENV
  }, {
    match: /\{\{content-for ['"](.+)["']\}\}/g,
    replacement: this.contentFor.bind(this)
  }, {
    match: /\{\{MODULE_PREFIX\}\}/g,
    replacement: calculateModulePrefix
  }];
};

/**
  Returns the tree for /tests/index.html

  @private
  @method testIndex
  @return {Tree} Tree for /tests/index.html
 */
EmberApp.prototype.testIndex = function() {
  var index = new Funnel(this.trees.tests, {
    srcDir: '/',
    files: ['index.html'],
    destDir: '/tests'
  });

  return configReplace(index, this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', 'test.json'),
    files: [ 'tests/index.html' ],
    env: 'test',
    patterns: this._configReplacePatterns()
  });
};

/**
  Returns the tree for /public

  @private
  @method publicTree
  @return {Tree} Tree for /public
 */
EmberApp.prototype.publicTree = function() {
  var trees = this.addonTreesFor('public');

  if (this.trees.public) {
    trees.push(this.trees.public);
  }

  return mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerge (public)'
  });
};


/**
  @private
  @method _processedAppTree
  @return
*/
EmberApp.prototype._processedAppTree = function() {
  var addonTrees = this.addonTreesFor('app');
  var mergedApp  = mergeTrees(addonTrees.concat(this._filterAppTree()), {
    overwrite: true,
    description: 'TreeMerger (app)'
  });

  return new Funnel(mergedApp, {
    srcDir: '/',
    destDir: this.name
  });
};

/**
  @private
  @method _processedTemplatesTree
  @return
*/
EmberApp.prototype._processedTemplatesTree = function() {
  var addonTrees = this.addonTreesFor('templates');
  var mergedTrees = this.trees.templates ? addonTrees.concat(this.trees.templates) : addonTrees;
  var mergedTemplates = mergeTrees(mergedTrees, {
    overwrite: true,
    description: 'TreeMerger (templates)'
  });

  var standardTemplates = new Funnel(mergedTemplates, {
    srcDir: '/',
    destDir: this.name + '/templates'
  });

  var podTemplates = new Funnel(this.trees.app, {
    include: this._podTemplatePatterns(),
    exclude: [ /^templates/ ],
    destDir: this.name + '/',
    description: 'Funnel: Pod Templates'
  });

  var templates = this.addonPreprocessTree('template', mergeTrees([
    standardTemplates,
    podTemplates
  ]));

  return this.addonPostprocessTree('template', preprocessTemplates(templates, {
    registry: this.registry,
    description: 'TreeMerger (pod & standard templates)'
  }));
};

/**
  @private
  @method _podTemplatePatterns
  @returns Array An array of regular expressions.
*/
EmberApp.prototype._podTemplatePatterns = function() {
  return this.registry.extensionsForType('template').map(function(extension) {
    return new RegExp('template.' + extension + '$');
  });
};

/**
  @private
  @method _processedTestsTree
  @return
*/
EmberApp.prototype._processedTestsTree = function() {
  var addonTrees  = this.addonTreesFor('test-support');
  var mergedTests = mergeTrees(addonTrees.concat(this.trees.tests), {
    overwrite: true,
    description: 'TreeMerger (tests)'
  });

  return new Funnel(mergedTests, {
    srcDir: '/',
    destDir: this.name + '/tests'
  });
};

/**
  @private
  @method _processedBowerTree
  @return
*/
EmberApp.prototype._processedBowerTree = function() {
  if(this._cachedBowerTree) {
    return this._cachedBowerTree;
  }

  // do not attempt to merge bower and vendor together
  // if they are the same tree
  if (this.bowerDirectory === 'vendor') {
    return;
  }

  this._cachedBowerTree = new Funnel(this.trees.bower, {
    srcDir: '/',
    destDir: this.bowerDirectory + '/'
  });

  return this._cachedBowerTree;
};

/**

*/
EmberApp.prototype._addonTree = function _addonTree() {
  if (this._cachedAddonTree) {
    return this._cachedAddonTree;
  }

  var addonTrees = mergeTrees(this.addonTreesFor('addon'), {
    overwrite: true,
    description: 'TreeMerger (addons)'
  });

  var addonES6 = new Funnel(addonTrees, {
    srcDir: 'modules',
    allowEmpty: true,
    description: 'Funnel: Addon JS'
  });

  // it is not currently possible to make Esperanto processing
  // pre-existing AMD a no-op, so we have to remove the reexports
  // to then merge them later :(
  var addonReexports = new Funnel(addonTrees, {
    srcDir: 'reexports',
    allowEmpty: true,
    description: 'Funnel: Addon Re-exports'
  });

  var transpiledAddonTree = new ES6Modules(addonES6, {
    description: 'ES6: Addon Trees',
    esperantoOptions: {
      absolutePaths: true,
      strict: true,
      _evilES3SafeReExports: this.options.es3Safe
    }
  });

  var reexportsAndTranspiledAddonTree = mergeTrees([
    transpiledAddonTree,
    addonReexports
  ], {
    description: 'TreeMerger: (re-exports)'
  });

  return this._cachedAddonTree = [
    this.concatFiles(addonTrees, {
      inputFiles: ['**/*.css'],
      outputFile: '/addons.css',
      allowNone: true,
      description: 'Concat: Addon CSS'
    }),

    this.concatFiles(reexportsAndTranspiledAddonTree, {
      inputFiles: ['**/*.js'],
      outputFile: '/addons.js',
      allowNone: true,
      description: 'Concat: Addon JS'
    })
  ];
};

/**
  @private
  @method _processedVendorTree
  @return
*/
EmberApp.prototype._processedVendorTree = function() {
  if(this._cachedVendorTree) {
    return this._cachedVendorTree;
  }

  var trees = this._importTrees.slice();
  trees = trees.concat(this._addonTree());
  trees = trees.concat(this.addonTreesFor('vendor'));

  if (this.trees.vendor) {
    trees.push(this.trees.vendor);
  }

  var mergedVendor = mergeTrees(trees, {
    overwrite: true,
    description: 'TreeMerger (vendor)'
  });

  this._cachedVendorTree = new Funnel(mergedVendor, {
    srcDir: '/',
    destDir: 'vendor/'
  });

  return this._cachedVendorTree;
};

/**
  @private
  @method _processedExternalTree
  @return
*/
EmberApp.prototype._processedExternalTree = function() {
  if (this._cachedExternalTree) {
    return this._cachedExternalTree;
  }

  var vendor = this._processedVendorTree();
  var bower = this._processedBowerTree();

  var trees = [vendor];
  if (bower) {
    trees.unshift(bower);
  }

  return this._cachedExternalTree = mergeTrees(trees, {
    description: 'TreeMerger (ExternalTree)'
  });
};

/**
  @private
  @method _configTree
  @return
*/
EmberApp.prototype._configTree = function() {
  if (this._cachedConfigTree) {
    return this._cachedConfigTree;
  }

  var configPath = this.project.configPath();
  var configTree = configLoader(path.dirname(configPath), {
    env: this.env,
    tests: this.tests,
    project: this.project
  });

  this._cachedConfigTree = new Funnel(configTree, {
    srcDir: '/',
    destDir: this.name + '/config'
  });

  return this._cachedConfigTree;
};

/**
  @private
  @method _processedEmberCLITree
  @return
*/
EmberApp.prototype._processedEmberCLITree = function() {
  if (this._cachedEmberCLITree) {
    return this._cachedEmberCLITree;
  }

  var files = [
    'vendor-prefix.js',
    'vendor-suffix.js',
    'app-prefix.js',
    'app-suffix.js',
    'app-boot.js',
    'test-support-prefix.js',
    'test-support-suffix.js'
  ];
  var emberCLITree = configReplace(unwatchedTree(__dirname), this._configTree(), {
    configPath: path.join(this.name, 'config', 'environments', this.env + '.json'),
    files: files,

    patterns: this._configReplacePatterns()
  });

  return this._cachedEmberCLITree = new Funnel(emberCLITree, {
    files: files,
    srcDir: '/',
    destDir: '/vendor/ember-cli/'
  });
};

/**
  Returns the tree for the app and its dependencies

  @private
  @method appAndDependencies
  @return {Tree} Merged tree
*/
EmberApp.prototype.appAndDependencies = function() {
  var app       = this.addonPreprocessTree('js', this._processedAppTree());
  var templates = this._processedTemplatesTree();
  var config    = this._configTree();

  if (!this.registry.availablePlugins['ember-cli-babel'] && this.options.es3Safe) {
    app = new ES3SafeFilter(app);
  }

  var external        = this._processedExternalTree();
  var preprocessedApp = preprocessJs(app, '/', this.name, {
    registry: this.registry
  });

  var postprocessedApp = this.addonPostprocessTree('js', preprocessedApp);
  var sourceTrees = [
    external,
    postprocessedApp,
    templates,
    config
  ];

  this._addAppTests(sourceTrees);

  var emberCLITree = this._processedEmberCLITree();

  sourceTrees.push(emberCLITree);

  return mergeTrees(sourceTrees, {
    overwrite: true,
    description: 'TreeMerger (appAndDependencies)'
  });
};

/**
  @private
  @method _addAppTests
  @param {Array} sourceTrees
*/
EmberApp.prototype._addAppTests = function(sourceTrees) {
  if (this.tests) {
    var tests = this.addonPreprocessTree('test', this._processedTestsTree());
    var preprocessedTests = preprocessJs(tests, '/tests', this.name, {
      registry: this.registry
    });

    sourceTrees.push(this.addonPostprocessTree('test', preprocessedTests));

    if (this.hinting) {
      var jshintedApp = this.addonLintTree('app', this._filterAppTree());
      var jshintedTests = this.addonLintTree('tests', this.trees.tests);

      jshintedApp = new Funnel(jshintedApp, {
        srcDir: '/',
        destDir: this.name + '/tests/'
      });

      jshintedTests = new Funnel(jshintedTests, {
        srcDir: '/',
        destDir: this.name + '/tests/'
      });

      sourceTrees.push(jshintedApp);
      sourceTrees.push(jshintedTests);
    }
  }
};

/**
  Returns the tree for javascript files

  @private
  @method javascript
  @return {Tree} Merged tree
*/
EmberApp.prototype.javascript = function() {
  var applicationJs       = this.appAndDependencies();
  var legacyFilesToAppend = this.legacyFilesToAppend;
  var appOutputPath       = this.options.outputPaths.app.js;

  var appJs = new ES6Modules(
    new Funnel(applicationJs, {
      include: [new RegExp('^' + escapeRegExp(this.name + '/') + '.*\\.js$')],
      description: 'Funnel: App JS Files'
    }),

    {
      description: 'ES6: App Tree',
      esperantoOptions: {
        absolutePaths: true,
        strict: true,
        _evilES3SafeReExports: this.options.es3Safe
      }
    }
  );

  appJs = mergeTrees([
    appJs,
    this._processedEmberCLITree()
  ], {
    description: 'TreeMerger (appJS  & processedEmberCLITree)'
  });

  appJs = this.concatFiles(appJs, {
    inputFiles: [this.name + '/**/*.js'],
    headerFiles: [
      'vendor/ember-cli/app-prefix.js'
    ],
    footerFiles: [
      'vendor/ember-cli/app-suffix.js',
      'vendor/ember-cli/app-boot.js'
    ],
    outputFile: appOutputPath,
    description: 'Concat: App'
  });

  var inputFiles = ['vendor/ember-cli/vendor-prefix.js']
    .concat(legacyFilesToAppend)
    .concat('vendor/addons.js')
    .concat('vendor/ember-cli/vendor-suffix.js');

  var vendor = this.concatFiles(applicationJs, {
    inputFiles: inputFiles,
    outputFile: this.options.outputPaths.vendor.js,
    separator: EOL + ';',
    description: 'Concat: Vendor'
  });

  return mergeTrees([
      vendor,
      appJs
    ], {
      description: 'TreeMerger (vendor & appJS)'
    });
};


/**
  Returns the tree for styles

  @private
  @method styles
  @return {Tree} Merged tree for styles
*/
EmberApp.prototype.styles = function() {
  if (this._processedStylesTree) {
    return this._processedStylesTree;
  }

  if (existsSync('app/styles/' + this.name + '.css')) {
    throw new SilentError('Style file cannot have the name of the application - ' + this.name);
  }

  var addonTrees = this.addonTreesFor('styles');
  var external = this._processedExternalTree();
  var styles = new Funnel(this.trees.styles, {
    srcDir: '/',
    destDir: '/app/styles'
  });

  var trees = [external].concat(addonTrees);
  trees.push(styles);

  var stylesAndVendor = this.addonPreprocessTree('css', mergeTrees(trees, {
    description: 'TreeMerger (stylesAndVendor)',
    overwrite: true
  }));

  var options = { outputPaths: this.options.outputPaths.app.css };
  options.registry = this.registry;
  var preprocessedStyles = preprocessCss(stylesAndVendor, '/app/styles', '/assets', options);


  var vendorStyles = this.addonPreprocessTree('css', this.concatFiles(stylesAndVendor, {
    inputFiles: this.vendorStaticStyles.concat(['vendor/addons.css']),
    outputFile: this.options.outputPaths.vendor.css,
    description: 'Concat: Vendor Styles'
  }));

  if (this.options.minifyCSS.enabled === true) {
    options = this.options.minifyCSS.options || {};
    options.registry = this.registry;
    preprocessedStyles = preprocessMinifyCss(preprocessedStyles, options);
    vendorStyles    = preprocessMinifyCss(vendorStyles, options);
  }

  var mergedTrees = mergeTrees([
      preprocessedStyles,
      vendorStyles
    ], {
      description: 'styles'
    });

  return this._processedStylesTree = this.addonPostprocessTree('css', mergedTrees);
};

/**
  Returns the tree for test files

  @private
  @method testFiles
  @return {Tree} Merged tree for test files
 */
EmberApp.prototype.testFiles = function() {
  var testSupportPath = this.options.outputPaths.testSupport.js;
  var testLoaderPath = this.options.outputPaths.testSupport.js.testLoader;

  testSupportPath = testSupportPath.testSupport || testSupportPath;

  var external = this._processedExternalTree();

  var emberCLITree = this._processedEmberCLITree();

  var testJs = this.concatFiles(external, {
    inputFiles: this.legacyTestFilesToAppend,
    outputFile: testSupportPath,
    description: 'Concat: Test Support JS'
  });

  testJs = this.concatFiles(mergeTrees([testJs, emberCLITree]), {
    inputFiles: [
      'vendor/ember-cli/test-support-prefix.js',
      testSupportPath.slice(1),
      'vendor/ember-cli/test-support-suffix.js'
    ],
    outputFile: testSupportPath,
    description: 'Concat: Test Support Suffix'
  });

  var testCss = this.concatFiles(external, {
    inputFiles: this.vendorTestStaticStyles,
    outputFile: this.options.outputPaths.testSupport.css,
    description: 'Concat: Test Support CSS'
  });

  var testemPath = path.join(__dirname, 'testem');
  testemPath = path.dirname(testemPath);

  var testemTree = new Funnel(unwatchedTree(testemPath), {
      files: ['testem.js'],
      srcDir: '/',
      destDir: '/'
    });

  if (this.options.fingerprint && this.options.fingerprint.exclude) {
    this.options.fingerprint.exclude.push('testem');
  }

  var testLoader = new Funnel(external, {
    files: ['test-loader.js'],
    srcDir: '/' + this.bowerDirectory + '/ember-cli-test-loader',
    destDir: path.dirname(testLoaderPath)
  });

  var sourceTrees = [
    testJs,
    testCss,
    testLoader,
    testemTree
  ];

  return mergeTrees(sourceTrees, {
      overwrite: true,
      description: 'TreeMerger (testFiles)'
    });
};

/**
  Returns the tree for the additional assets which are not in
  one of the default trees.

  @private
  @method otherAssets
  @return {Tree} Merged tree for other assets
 */
EmberApp.prototype.otherAssets = function() {
  var external = this._processedExternalTree();
  var otherAssetTrees = this.otherAssetPaths.map(function (path) {
    return new Funnel(external, {
      srcDir: path.src,
      files: [path.file],
      destDir: path.dest
    });
  });
  return mergeTrees(otherAssetTrees, {
    description: 'TreeMerger (otherAssetTrees)'
  });
};

/**
  @public
  @method dependencies
  @return {Object} Alias to the project's dependencies function
*/
EmberApp.prototype.dependencies = function(pkg) {
  return this.project.dependencies(pkg);
};

/**
  Imports an asset into the application.

  Options:
  - type - Either 'vendor' or 'test', defaults to 'vendor'
  - prepend - Whether or not this asset should be prepended, defaults to false
  - destDir - Destination directory, defaults to the name of the directory the asset is in

  @public
  @method import
  @param  {(Object|String)}  asset   Either a path to the asset or an object with envirnoment names and paths as key-value pairs.
  @param  {Object=} options Options object
 */
EmberApp.prototype.import = function(asset, options) {
  var assetPath = this._getAssetPath(asset);

  if (!assetPath) {
    return;
  }

  options = defaults(options || {}, {
    type: 'vendor',
    prepend: false
  });

  var directory    = path.dirname(assetPath);
  var subdirectory = directory.replace(new RegExp('^vendor/|' + this.bowerDirectory), '');
  var extension    = path.extname(assetPath);

  if (!extension) {
    throw new Error('You must pass a file to `app.import`. For directories specify them to the constructor under the `trees` option.');
  }

  this._importAssetTree(directory, subdirectory);

  this._import(
    assetPath,
    options,
    directory,
    subdirectory,
    extension
  );
};

/**
  @private
  @method _import
  @param {String} assetPath
  @param {Object} options
  @param {String} directory
  @param {String} subdirectory
  @param {String} extension
 */
EmberApp.prototype._import = function(assetPath, options, directory, subdirectory, extension) {
  var basename = path.basename(assetPath);

  if (isType(assetPath, 'js', {registry: this.registry})) {
    if(options.type === 'vendor') {
      if (options.prepend) {
        this.legacyFilesToAppend.unshift(assetPath);
      } else {
        this.legacyFilesToAppend.push(assetPath);
      }
    } else if (options.type === 'test' ) {
      this.legacyTestFilesToAppend.push(assetPath);
    } else {
      throw new Error( 'You must pass either `vendor` or `test` for options.type in your call to `app.import` for file: '+basename );
    }
  } else if (extension === '.css') {
    if(options.type === 'vendor') {
      this.vendorStaticStyles.push(assetPath);
    } else {
      this.vendorTestStaticStyles.push(assetPath);
    }
  } else {
    var destDir = options.destDir;
    if (destDir === '') {
      destDir = '/';
    }
    this.otherAssetPaths.push({
      src: directory,
      file: basename,
      dest: destDir || subdirectory
    });
  }
};

/**
  @private
  @method _importAssetTree
  @param {String} directory
  @param {String} subdirectory
 */
EmberApp.prototype._importAssetTree = function(directory, subdirectory) {
  if (existsSync(directory) && this._importTrees.indexOf(directory) === -1) {
    var assetTree = new Funnel(directory, {
      srcDir: '/',
      destDir: subdirectory
    });

    this._importTrees.push(assetTree);
  }
};

/**
  @private
  @method _getAssetPath
  @param {(Object|String)} asset
  @return {(String|undefined)} assetPath
 */
EmberApp.prototype._getAssetPath = function(asset) {
  /** @type {String} */
  var assetPath;

  if (typeof asset === 'object') {
    if (this.env in asset) {
      assetPath = asset[this.env];
    } else {
      assetPath = asset.development;
    }
  } else {
    assetPath = asset;
  }

  if (!assetPath) {
    return;
  }

  assetPath = assetPath.replace(path.sep, '/');

  if (assetPath.split('/').length < 2) {
    console.log(chalk.red('Using `app.import` with a file in the root of `vendor/` causes a significant performance penalty. Please move `'+ assetPath + '` into a subdirectory.'));
  }

  if (/[\*\,]/.test(assetPath)) {
    throw new Error('You must pass a file path (without glob pattern) to `app.import`.  path was: `' + assetPath + '`');
  }

  return assetPath;
};

/**
  Returns an array of trees for this application

  @private
  @method toArray
  @return {Array} An array of trees
 */
EmberApp.prototype.toArray = function() {
  var sourceTrees = [
    this.index(),
    this.javascript(),
    this.styles(),
    this.otherAssets(),
    this.publicTree()
  ];

  if (this.tests) {
    sourceTrees = sourceTrees.concat(this.testIndex(), this.testFiles());
  }

  return sourceTrees;
};

/**
  Returns the merged tree for this application

  @public
  @method toTree
  @param  {Array} additionalTrees Array of additional trees to merge
  @return {Tree}                  Merged tree for this application
 */
EmberApp.prototype.toTree = function(additionalTrees) {
  var tree = mergeTrees(this.toArray().concat(additionalTrees || []), {
    overwrite: true,
    description: 'TreeMerger (allTrees)'
  });

  return this.addonPostprocessTree('all', tree);
};

/**
  Returns the content for a specific type (section) for index.html.

  Currently supported types:
  - 'head'
  - 'config-module'
  - 'app'
  - 'head-footer'
  - 'test-header-footer'
  - 'body-footer'
  - 'test-body-footer'

  Addons can also implement this method and could also define additional
  types (eg. 'some-addon-section').

  @private
  @method contentFor
  @param  {Object} config Application configuration
  @param  {RegExp} match  Regular expression to match against
  @param  {String} type   Type of content
  @return {String}        The content.
 */
EmberApp.prototype.contentFor = function(config, match, type) {
  var content = [];

  switch (type) {
    case 'head':          this._contentForHead(content, config);         break;
    case 'config-module': this._contentForConfigModule(content, config); break;
    case 'app-boot':      this._contentForAppBoot(content, config);      break;
  }

  content = this.project.addons.reduce(function(content, addon) {
    var addonContent = addon.contentFor ? addon.contentFor(type, config) : null;
    if (addonContent) {
      return content.concat(addonContent);
    }

    return content;
  }, content);

  return content.join('\n');
};

/**
  @private
  @method _contentForHead
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForHead = function(content, config) {
  content.push(calculateBaseTag(config));

  if (this.options.storeConfigInMeta) {
    content.push('<meta name="' + config.modulePrefix + '/config/environment" ' +
                 'content="' + escape(JSON.stringify(config)) + '" />');
  }
};

/**
  @private
  @method _contentForConfigModule
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForConfigModule = function(content, config) {
  if (this.options.storeConfigInMeta) {
    content.push('var prefix = \'' + config.modulePrefix + '\';');
    content.push(fs.readFileSync(path.join(__dirname, 'app-config-from-meta.js')));
  } else {
    content.push('return { \'default\': ' + JSON.stringify(config) + '};');
  }
};

/**
  @private
  @method _contentForAppBoot
  @param {Array} content
  @param {Object} config
*/
EmberApp.prototype._contentForAppBoot = function(content, config) {
  content.push('if (runningTests) {');
  content.push('  require("' +
    config.modulePrefix +
    '/tests/test-helper");');
  if (this.options.autoRun) {
    content.push('} else {');
    content.push('  require("' +
      config.modulePrefix +
      '/app")["default"].create(' +
      calculateAppConfig(config) +
      ');');
  }
  content.push('}');
};

/**
  Returns the <base> tag for index.html

  @param  {Object} config Application configuration
  @return {String}        Base tag or empty string
 */
function calculateBaseTag(config){
  var baseURL      = cleanBaseURL(config.baseURL);
  var locationType = config.locationType;

  if (locationType === 'hash') {
    return '';
  }

  if (baseURL) {
    return '<base href="' + baseURL + '" />';
  } else {
    return '';
  }
}

function calculateEmberENV(config) {
  return JSON.stringify(config.EmberENV || {});
}

function calculateAppConfig(config) {
  return JSON.stringify(config.APP || {});
}

function calculateModulePrefix(config) {
  return config.modulePrefix;
}
