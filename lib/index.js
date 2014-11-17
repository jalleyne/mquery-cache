'use strict';

/**
 * Module dependencies.
 */

var debug         = require('debug')('mquery-cache')
  , EventEmitter  = require('events').EventEmitter
  , util          = require('util')
  , _             = require('underscore')
  , stringhash    = require('string-hash')
  , Cache         = require('ttl-cache')
;



/**
 * Default object hashing algorithm to return a unique
 * key representation of an object.
 *
 * @param {Object} query
 * @return {String} hash
 * @api private
 */
function keyhasher(query){
  return stringhash(JSON.stringify({
    options: query._mongooseOptions,
    collection: query._collection.collection.name,
    conditions: query.options,
    fields: query._fields
  }));
}


/**
 * CachedQuery constructor.
 *
 * @param {String|Number} key
 * @param {Object} query
 * @param {Mixed} data
 * @param {String|Number} ttl
 * @return {CachedQuery} this
 * @api private
 */
function CachedQuery(key,query,data,ttl){
  this.query = query;
  this.ttl = ttl;
  this.data = data;
  this.key = key;
}



function TTLCacheCollection(values){
  util.inherits(TTLCacheCollection, EventEmitter);
  this.values = values || {};
  this._ttlIntervals = {};
}

TTLCacheCollection.prototype.add = function(cache){
  var _this = this;
  this.remove(cache,true);
  this.values[ cache.key] = cache;
  this._ttlIntervals[ cache.key] = setTimeout(function(){
    delete _this.values[ cache.key];
    delete _this._ttlIntervals[ cache.key]
    _this.emit('expire');
  }, cache.ttl*1000);
  this.emit('add',cache,this);
}

TTLCacheCollection.prototype.remove = function(cache,silent){
  if(this._ttlIntervals[ cache.key]) {
    clearTimeout(this._ttlIntervals[ cache.key]);
    delete this._ttlIntervals[ cache.key];
    delete this.values[ cache.key];
    if(!silent) this.emit('remove');
  }
}

TTLCacheCollection.prototype.get = function(key){
  return this.values[ key];
}



/**
 * Expose module.
 */
module.exports = function(Query, Promise, options){
  var caches = new TTLCacheCollection
    , opts = {
      ttl: 10,
      hasher: keyhasher
    }
  ;

  // Combine default and user defined options.
  options = _.extend(opts, options || {});

  // Hash function.
  var hashCacheKey = options.hasher;

  /**
   * Cache setter. Calling this method on a query
   * will trigger cache to be turned on with the
   * supplied ttl.
   *
   * @param {Number|String} ttl
   * @return {Query} this
   * @api public
   */
  Query.prototype.cache = function(ttl){

    // Restrict caching to `find` operations only.
    if(/^find/ig.test(this.op)) {
      debug('Caching query %j', this._mongooseOptions);

      // Capture current exec method to call later.
      var exec = this.exec;

      /**
       * Overwrite default Query.exec and call it only
       * when there is no cache to return.
       *
       * @param {String} op
       * @param {Function} callback
       * @return {Promise} promise
       * @api public
       */
      this.exec = function(op, callback){
        debug('Executing cachable query');

        // Generate query key and check for existing cache.
        var key   = hashCacheKey(this)
          , cache = caches.get(key)
        ;

        debug('Validating cache for key %s', key);

        // if cache exists validate and return it.
        if(cache){
          debug('Cached results found for key', key);

          // Create promise to send data back through callback.
          var promise = new Promise();

          // Check arguments.
          if( 'function' === typeof op){
            callback = op;
            op = null;
          }else if( 'string' === typeof op){
            this.op = op;
          }
          if(callback) promise.addBack(callback);

          // Resolve promise with cached data.
          return promise.resolve(null, cache.data);

        }
        // Otherwise query the database as normal.
        else{
          debug('No results cached for query %j', this._mongooseOptions);

          // Execute query
          var promise = exec.apply( this, arguments);

          // Get notified when promise has been
          // resolved and cache results.
          promise.addBack( function(err,results){
            if(results) {
              debug('Promise returned results');
              // Create cache instance
              var cache = new CachedQuery(key, this, results, ttl || options.ttl);
              // Set cache in caches with appropriate ttl
              caches.set(cache.key, cache);
              caches.ttl(cache.key, cache.ttl);
            }
          });
          return promise;
        }
      }
    };
    return this;
  }
}
