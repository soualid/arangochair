'use strict';

const EventEmitter = require('events');

const https = require('request-easy').https; 
const http  = require('request-easy').http;
const url  = require('url');

const mapTextToType = {
    'insert/update':'2300',
    'delete':'2302'
};
const mapTypeToText = {
    '2300': 'insert/update',
    '2302': 'delete'
};

var mapShardToCollection = null;

class ArangoChair extends EventEmitter {
    constructor(adbUrl, auth, coordinatorUrl=null, coordinatorAuth=null) {
        super();
        this.adbUrl = url.parse(adbUrl);
        this.options = {
            hostname:this.adbUrl.hostname,
            port:this.adbUrl.port
        };
        if (auth) {
            this.options.headers = {
                'Authorization': auth
            };
        }

        const db = '/' === this.adbUrl.pathname ? '/_system' : this.adbUrl.pathname;
        if (coordinatorUrl != null) {
            this.adbCoordinatorUrl = url.parse(coordinatorUrl);
            if (coordinatorAuth) {

                this.coordinatorOptions = {
                    hostname:this.adbCoordinatorUrl.hostname,
                    port:this.adbCoordinatorUrl.port
                };
                this.coordinatorOptions.headers = {
                    'Authorization': coordinatorAuth
                };
            }
            this._shardDistributionPath = `/_db${db}/_admin/cluster/shardDistribution`;
        }
        this.req = new (this.adbUrl.protocol === 'https:'? https : http)(this.options);

        this._loggerStatePath  = `/_db${db}/_api/replication/logger-state`;
        this._loggerFollowPath = `/_db${db}/_api/replication/logger-follow`;
        

        this.collectionsMap = new Map();
        this._stopped = false;
    }

    start() {
        this._stopped = false;
        if (this.adbCoordinatorUrl) {
            var req = new (this.adbCoordinatorUrl.protocol === 'https:'? https : http)(this.coordinatorOptions);
            req.get({path:this._shardDistributionPath}, (status, headers, body) => {
                mapShardToCollection = {};
                var shardplan = JSON.parse(body.toString());
                for (var collection in shardplan.results) {
                    var shards = shardplan.results[collection].Current;
                    for (var shard in shards) {
                        mapShardToCollection[shard] = collection;
                    }
                }
                this._startLoggerState();
            });       
        } else {
            this._startLoggerState();
        }     
    }

    stop() {
        this._stopped = true;
    }

    _startLoggerState() {

        if (this.req == null) {
            this.req = new (this.adbUrl.protocol === 'https:'? https : http)(this.options);
        }
        this.req.get({path:this._loggerStatePath}, (status, headers, body) => {

            if (status === 0) {
                this.stop();
                this._startLoggerState();
                return;
            }
            if (200 !== status) {
                this.emit('error', new Error('E_LOGGERSTATE'), status, headers, body);
                this.stop();
                return;
            } // if

            body = JSON.parse(body);
            let lastLogTick = body.state.lastLogTick;
            let start = 0;
            let idx   = 0;

            let type  = 0;
            let tid   = 0;
            let entry = 0;

            let typeStartIdx = 0;
            let typeEndIdx   = 0;
            let idx0 = 0;
            let idx1 = 0;

            const typeStartBuffer       = Buffer.from('type":');
            const cnameStartBuffer      = Buffer.from('cname":"');
            const keyStartBuffer        = Buffer.from('_key":"');
            const commaDoubleTickBuffer = Buffer.from(',"');
            const tidBuffer = Buffer.from('tid":');

            const txns = new Map();

            const handleEntry = () => {
                var colName;

                idx0 = entry.indexOf(cnameStartBuffer, idx0 + 2) + 8;
                idx1 = entry.indexOf(commaDoubleTickBuffer, idx0) - 1;    
                colName = entry.slice(idx0, idx1).toString();

                if (mapShardToCollection != null) {
                    // map shard to collection name
                    colName = mapShardToCollection[colName];
                }

                const colConf = this.collectionsMap.get(colName);
                if (undefined === colConf) return;

                const events = colConf.get('events');

                if (0 !== events.size && !events.has(type)) return;

                idx0 = entry.indexOf(keyStartBuffer, idx1 + 9);
                const key = entry.slice(idx0+7, entry.indexOf(commaDoubleTickBuffer, idx0+7)-1).toString();
                const keys = colConf.get('keys');

                if (0 !== keys.size && !events.has(key)) return;

                this.emit(colName, JSON.parse(entry.toString()).data, mapTypeToText[type]);
            };

            const ticktock = () => {
                if (this._stopped) return;

                this.req.get({path:`${this._loggerFollowPath}?from=${lastLogTick}`}, (status, headers, body) => {
                    if (status === 0) {
                        return setTimeout(ticktock, 500);
                    }
                    if (204 < status || 0 === status) {
                        this.emit('error', new Error('E_LOGGERFOLLOW'), status, headers, body);
                        this.stop();
                        return;
                    } // if

                    if ('0' === headers['x-arango-replication-lastincluded']) {
                        return setTimeout(ticktock, 500);
                    } // if

                    lastLogTick = headers['x-arango-replication-lastincluded'];

                    start = idx = 0;
                    while(true) {
                        idx = body.indexOf('\n', start);
                        if (-1 === idx) break;

                        entry = body.slice(start, idx);
                        start = idx+1;

                        // transaction   {"tick":"514132959101","type":2200,"tid":"514132959099","database":"1"}
                        // insert/update {"tick":"514092205556","type":2300,"tid":"0","database":"1","cid":"513417247371","cname":"test","data":{"_id":"test/testkey","_key":"testkey","_rev":"514092205554",...}}
                        // delete        {"tick":"514092206277","type":2302,"tid":"0","database":"1","cid":"513417247371","cname":"test","data":{"_key":"abcdef","_rev":"514092206275"}}
                        
                        idx0 = entry.lastIndexOf(typeStartBuffer) + 6;            // find type":
                        idx1 = entry.indexOf(commaDoubleTickBuffer, idx0);    // find ,"
                        type = entry.slice(idx0, idx1).toString();

                        idx0 = entry.indexOf(tidBuffer) + 6;
                        idx1 = entry.indexOf(commaDoubleTickBuffer, idx0);    // find ,"
                        tid  = entry.slice(idx0, idx1 - 1).toString();

                        if ('2200' === type) { // txn start
                            txns.set(tid, new Set());

                        } else if ('2201' === type) { // txn commit and replay docs
                            for(const data of txns.get(tid)) {
                                idx0 = 0;
                                [type, entry] = data;
                                handleEntry();
                            } // for
                            txns.delete(tid);

                        } else if ('2002' === type) { // txn abort
                            txns.delete(tid);

                        } else {
                            if ('2300' !== type && '2302' !== type) continue;

                            if ('0' !== tid) {
                                var tmp = txns.get(tid);
                                tmp.add([type,entry]);
                                continue;
                            } // if

                            handleEntry();
                        } // else
                    } // while
                    ticktock();
                });
            }
            ticktock();
        });
    }

    subscribe(confs) {
        if ('string' === typeof confs) confs = {collection:confs};
        if (!Array.isArray(confs))     confs = [confs];

        for(const conf of confs) {
            let colConfMap = undefined;
            if (this.collectionsMap.has(conf.collection)) {
                colConfMap = this.collectionsMap.get(conf.collection);
            } else {
                colConfMap = new Map([ ['events', new Set()],['keys', new Set()] ]);
                this.collectionsMap.set(conf.collection, colConfMap);
            }

            if (conf.events) {
                for(const event of conf.events) {
                    colConfMap.get('events').add(mapTextToType[event]);
                } // for
            } // if
            if (conf.keys) {
                for(const key of conf.keys) {
                    colConfMap.get('keys').add(key);
                } // for
            } // if
        } // for
    } // subscribe()

    unsubscribe(confs) {
        if ('string' === typeof confs) confs = {collection:confs};
        if (!Array.isArray(confs))     confs = [confs];

        for(const conf of confs) {
            if (conf.events) {
                const events = this.collectionsMap.get(conf.collection).get('events');
                for(const event of conf.events) {
                    events.delete(mapTextToType[event]);
                } // for
            } // if
            if (conf.keys) {
                const keys = this.collectionsMap.get(conf.collection).get('keys');
                for(const key of conf.keys) {
                    keys.delete(key);
                } // for
            }// if

            if (!conf.events && !conf.keys) {
                this.collectionsMap.delete(conf.collection);
            } // if
        } // for
    } // unsubscribe()
}


module.exports = ArangoChair;
