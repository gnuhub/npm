'use strict'
var fs = require('fs')
var path = require('path')
var url = require('url')
var writeFileAtomic = require('write-file-atomic')
var log = require('npmlog')
var semver = require('semver')
var iferr = require('iferr')
var sortedObject = require('sorted-object')
var validate = require('aproba')
var without = require('lodash.without')
var npm = require('../npm.js')

// if the -S|--save option is specified, then write installed packages
// as dependencies to a package.json file.

exports.saveRequested = function (args, tree, andReturn) {
  validate('AOF', arguments)
  savePackageJson(args, tree, andWarnErrors(andSaveShrinkwrap(tree, andReturn)))
}

function andSaveShrinkwrap (tree, andReturn) {
  validate('OF', arguments)
  return function (er) {
    validate('E', arguments)
    saveShrinkwrap(tree, andWarnErrors(andReturn))
  }
}

function andWarnErrors (cb) {
  validate('F', arguments)
  return function (er) {
    if (er) log.warn('error', er.message)
    arguments[0] = null
    cb.apply(null, arguments)
  }
}

function saveShrinkwrap (tree, next) {
  validate('OF', arguments)
  var saveTarget = path.resolve(tree.path, 'npm-shrinkwrap.json')
  fs.stat(saveTarget, function (er, stat) {
    if (er) return next()
    var save = npm.config.get('save')
    var saveDev = npm.config.get('save-dev')
    var saveOptional = npm.config.get('save-optional')
    if (!saveOptional && saveDev) return next()
    if (saveOptional || !save) return next()
    npm.commands.shrinkwrap([], true, next)
  })
}

function savePackageJson (args, tree, next) {
  validate('AOF', arguments)
  var saveBundle = npm.config.get('save-bundle')

  // each item in the tree is a top-level thing that should be saved
  // to the package.json file.
  // The relevant tree shape is { <folder>: {what:<pkg>} }
  var saveTarget = path.resolve(tree.path, 'package.json')
  // don't use readJson, because we don't want to do all the other
  // tricky npm-specific stuff that's in there.
  fs.readFile(saveTarget, iferr(next, function (packagejson) {
    try {
      packagejson = JSON.parse(packagejson.toString('utf8'))
    } catch (ex) {
      return next(ex)
    }

    // If we're saving bundled deps, normalize the key before we start
    if (saveBundle) {
      var bundle = packagejson.bundleDependencies || packagejson.bundledDependencies
      delete packagejson.bundledDependencies
      if (!Array.isArray(bundle)) bundle = []
      packagejson.bundleDependencies = bundle.sort()
    }

    var toSave = getThingsToSave(tree)
    var toRemove = getThingsToRemove(args, tree)
    var savingTo = {}
    toSave.forEach(function (pkg) { savingTo[pkg.save] = true })
    toRemove.forEach(function (pkg) { savingTo[pkg.save] = true })

    Object.keys(savingTo).forEach(function (save) {
      if (!packagejson[save]) packagejson[save] = {}
    })

    log.verbose('saving', toSave)
    toSave.forEach(function (pkg) {
      packagejson[pkg.save][pkg.name] = pkg.spec
      if (saveBundle) {
        var ii = bundle.indexOf(pkg.name)
        if (ii === -1) bundle.push(pkg.name)
      }
    })

    toRemove.forEach(function (pkg) {
      delete packagejson[pkg.save][pkg.name]
      if (saveBundle) {
        bundle = without(bundle, pkg.name)
      }
    })

    Object.keys(savingTo).forEach(function (save) {
      packagejson[save] = sortedObject(packagejson[save])
    })

    if (saveBundle) {
      packagejson.bundleDependencies = bundle.sort()
    }

    var json = JSON.stringify(packagejson, null, 2) + '\n'
    writeFileAtomic(saveTarget, json, next)
  }))
}

var getSaveType = exports.getSaveType = function (args) {
  validate('A', arguments)
  var nothingToSave = !args.length
  var globalInstall = npm.config.get('global')
  var noSaveFlags = !npm.config.get('save')
                 && !npm.config.get('save-dev')
                 && !npm.config.get('save-optional')
  if (nothingToSave || globalInstall || noSaveFlags) return null

  if (npm.config.get('save-optional')) return 'optionalDependencies'
  else if (npm.config.get('save-dev')) return 'devDependencies'
  else return 'dependencies'
}

function computeVersionSpec (child) {
  validate('O', arguments)
  var requested = child.package._requested || {
    type: 'version',
    spec: child.package.version
  }
  if (requested.type === 'vesion' || requested.type === 'range') {
    var version = child.package.version
    var rangeDescriptor = ''
    if (semver.valid(version, true) &&
        semver.gte(version, '0.1.0', true) &&
        !npm.config.get('save-exact')) {
      rangeDescriptor = npm.config.get('save-prefix')
    }
    return rangeDescriptor + version
  } else if (requested.type === 'directory' || requested.type === 'local') {
    var relativePath = path.relative(child.parent.path, requested.spec)
    if (/^[.][.]/.test(relativePath)) {
      return url.format({
        protocol: 'file',
        slashes: true,
        pathname: requested.spec
      })
    } else {
      return url.format({
        protocol: 'file',
        slashes: false,
        pathname: relativePath
      })
    }
  } else {
    return requested.spec
  }
}

function getThingsToSave (tree) {
  validate('O', arguments)
  var toSave = tree.children.filter(function (child) {
    return child.save
  }).map(function (child) {
    return {
      name: child.package.name,
      spec: computeVersionSpec(child),
      save: child.save
    }
  })
  return toSave
}

function getThingsToRemove (args, tree) {
  validate('AO', arguments)
  if (!tree.removed) return []
  var toRemove = tree.removed.map(function (child) {
    return {
      name: child.package.name,
      save: child.save
    }
  })
  var saveType = getSaveType(args)
  args.forEach(function(arg) {
    toRemove.push({
      name: arg,
      save: saveType
    })
  })
  return toRemove
}