'use strict';

/**
 * Module dependencies.
 */

var debug         = require('debug')('mquery-cache')
  , EventEmitter  = require('events').EventEmitter
  , util          = require('util')
  , _             = require('underscore')
  , stringhash    = require('string-hash')
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
  var keyData = {
      options: query._mongooseOptions,
      collection: query._collection.collection.name,
      conditions: query._conditions,
      fields: query._fields,
      path: query._path,
      distinct: query._distinct
    }
  , key = stringhash(JSON.stringify(keyData));
  debug('Hashing key [ %s ] with data %j', key, keyData);
  return key;
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
  //
  this.query  = query;
  this.ttl    = ttl;
  this._data  = data;
  this.key    = key;
  this.refreshing = false;
}
util.inherits(CachedQuery, EventEmitter);


Object.defineProperty(CachedQuery.prototype, 'data', {
  get: function(){
    return this._data || null;
  },
  set: function(val){
    var oldval = this._data;
    this._data = val;
    debug('Cache [ %s ] refreshed',this.key);
    this.emit('refresh',val,oldval);
  }
});



/**
 * TTLCacheCollection constructor.
 *
 * @param {Array} values
 * @return {TTLCacheCollection} this
 * @api private
 */
function TTLCacheCollection(values){
  this.values = values || {};
  this._ttlIntervals = {};
}
util.inherits(TTLCacheCollection, EventEmitter);

TTLCacheCollection.prototype.add = function(cache){
  debug('Adding cache [ %s ] to collection',cache.key);
  var _this = this;
  this.remove(cache.key,true);
  this.values[ cache.key] = cache;
  this._ttlIntervals[ cache.key] = setTimeout(function(){
    debug('Cache [ %s ] expired',cache.key);
    delete _this.values[ cache.key];
    delete _this._ttlIntervals[ cache.key]
    _this.emit('expire');
  }, cache.ttl*1000);
  this.emit('add',cache,this);
}

TTLCacheCollection.prototype.remove = function(key,silent){
  if(this._ttlIntervals[ key]) {
    debug('Removing cache [ %s ] from collection',key);
    clearTimeout(this._ttlIntervals[ key]);
    delete this._ttlIntervals[ key];
    delete this.values[ key];
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

    //
    debug('Checking query operation [%s] for cacheability', this.op);

    // Restrict caching to `find` operations only.
    if(/^(find)(?![a-z]+(update))/ig.test(this.op)) {
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

        //
        debug('Validating cache for key %s', key);

        // Check arguments.
        if( 'function' === typeof op){
          callback = op;
          op = null;
        }else if( 'string' === typeof op){
          this.op = op;
        }

        // if cache exists validate and return it.
        if(cache&&cache.refreshing===false){
          debug('Cached results found for key', key);

          // Create promise to send data back through callback.
          var promise = new Promise();

          if(callback) promise.addBack(callback);

          // Resolve promise with cached data.
          return promise.resolve(null, cache.data);

        }
        // Otherwise query the database as normal.
        else{
          debug('No cache found for query %j', this.options);

          // Create cache instance
          cache = cache || new CachedQuery(key, this, null, ttl || options.ttl);

          // Checking if another request is already updating cached query
          if(cache.refreshing){
            // Create promise to send data back through callback.
            var promise = new Promise();
            //
            cache.once('refresh', function(val,oldval){
              debug('Cache refreshed results');
              promise.resolve(null, val);
            });
          }else{
            //
            cache.refreshing = true;

            // Execute query
            var promise = exec.apply( this, arguments);

            // Get notified when promise has been
            // resolved and cache results.
            promise.addBack( function(err,results){
              if(results) {
                debug('Promise returned results');
                //
                cache.refreshing = false;
                //
                cache.data = results;
                // Set cache in caches
                caches.add(cache);
              }
            });
          }
          //
          return promise;
        }
      }
    };
    return this;
  };

}
