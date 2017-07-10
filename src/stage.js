const
    _ = require('lodash'),
    uuid = require('uuid'),
    kefir = require('kefir'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    Stream = require('stream'),
    DockerClientFactory = require('../lib/docker'),
    tapTestFrameworkCollect = require('./collect/tap_test_framework'),
    exitCodeCollect = require('./collect/exit_code'),
    standardOutputFilesystemCollect = require('./collect/standard_output_filesystem');
    standardOutputLogCollect = require('./collect/standard_output_log');
    filesystemCollect = require('./collect/filesystem');

const CONTAINER_TIMEOUT = 160; // Seconds

const getImageForStageName = _.partial(_.get, {
    "mocha": "codefresh/test_harness",
    "git": "bwits/docker-git-alpine",
    "node_6": "node:6-alpine"
}, _, 'alpine:3.1');

const Importers = {
    "environment": function(registry, dockerClient, { from, variable_name }){
        return registry.getValue(from).then((value)=>({ [variable_name]: value }));
    },
    "filesystem": function(registry, dockerClient, { from, folder, _containerId }){
        let getKeyName = (key)=> registry.get(key).then(({ type, value })=> type === "pointer" ? getKeyName(value) : key);
        return getKeyName(from).then((key)=> {
            return registry.getStream(key).then((stream)=> {
                return dockerClient.setFileSystemPath({ containerId: _containerId, path: folder, stream }).then(()=>{});
            }).catch((x)=>console.warn(x.toString('utf8')));
        });
    }
};

const Collectors = {
    "exit_code": exitCodeCollect,
    "tap_test_framework": tapTestFrameworkCollect,
    "standard_output_log": standardOutputLogCollect,
    "filesystem": filesystemCollect,
    "standard_output_filesystem": standardOutputFilesystemCollect
};

const
    DOCKER_CLIENT = Symbol('DockerClient'),
    REGISTRY = Symbol('Registry');

module.exports = class extends EventEmitter {
    constructor({ dockerClientConfiguration, registry }){
        super();
        Object.assign(this, {
            [REGISTRY]: registry,
            [DOCKER_CLIENT]: DockerClientFactory(dockerClientConfiguration)
        });
    }
    run({ type, ["import"]: _import, command }){

        let [dockerClient, registry] = [DOCKER_CLIENT, REGISTRY].map((symbol)=> this[symbol]),
            containerIdProperty = kefir
                .fromPromise(dockerClient.createContainer({ cmd: ["sleep", CONTAINER_TIMEOUT.toString()], name: ["cf", uuid()].join('_'), image: getImageForStageName(type) }))
                .flatMap(({ containerId })=> kefir.fromPromise(dockerClient.startContainer({ containerId })).map(_.constant(containerId)))
                .toProperty();

        let environmentVariableProperty = containerIdProperty.flatMap((containerId)=> {
            return kefir.combine(_import.map((importConfig)=>
                kefir.fromPromise(Importers[importConfig["to"]](registry, dockerClient, _.assign(importConfig, { _containerId: containerId })))
            ), _.assign);
        }).toProperty();

        let containerEndStream = containerIdProperty
            .flatMap((containerId)=> {
                return kefir
                    .fromPromise(dockerClient.attachContainer({ containerId }))
                    .flatMap(({ stdout })=> kefir.fromEvents(stdout, 'end').take(1));
            });

        let artifactStream = kefir
            .combine([containerIdProperty, environmentVariableProperty])
            .flatMap(([containerId, env])=> {
                return kefir
                    .concat(command.map(({ run, collect }, commandIndex)=> {
                        return kefir
                            .later()
                            .flatMap(()=> {
                                return kefir
                                    .fromPromise(dockerClient.createExec({ containerId, cmd: run, env }))
                                    .flatMap(({ execId })=> kefir.fromPromise(dockerClient.startExec({ execId })).map(_.partial(_.assign, { execId })))
                                    .flatMap(({ stdout, stderr, execId })=> {

                                        stdout.on('data', this.emit.bind(this, 'stdout'));
                                        stderr.on('data', this.emit.bind(this, 'stderr'));
                                        //stdout.pipe(process.stdout);
                                        //stderr.pipe(process.stderr);

                                        let commandApi = {
                                            getOutput: ()=> Promise.resolve({ stdout, stderr }),
                                            getExitCode: (function(promise){ return ()=> promise; })(kefir.fromEvents(stdout, 'end').take(1).flatMap(()=> kefir.fromPromise(dockerClient.inspectExec({ execId })).map(_.property('exit_code'))).toPromise()),
                                            getFileSystem(path = "/"){ return this.getExitCode().then(()=> dockerClient.getFileSystemPath({ containerId, path })) }
                                        };

                                        return kefir
                                            .combine(
                                                collect.map((collectorObject, collectorIndex) => {
                                                    let
                                                        { alias, type = collectorObject } = collectorObject,
                                                        collector = Collectors[type] || (()=> Promise.reject('Unsupported Collector'));

                                                    return kefir
                                                        .fromPromise(collector(commandApi, _.isObject(collectorObject) ? collectorObject : {}))
                                                        .flatMap((data)=> {
                                                            this.emit('artifact', {
                                                                command_index: commandIndex,
                                                                collector_index: collectorIndex,
                                                                data_type: collector["data_type"],
                                                                data,
                                                                alias
                                                            });
                                                            return ((data instanceof Stream) ? kefir.fromEvents(data, 'end').take(1) : kefir.constant()).map(_.constant(true));
                                                        })
                                                        .flatMapErrors((err) => {
                                                            this.emit('error', err);
                                                            return kefir.constant(false);
                                                        });
                                                })
                                            );
                                    });
                            })
                    }));
            }).last();

        // Remove stage main container
        return kefir
            .combine([containerIdProperty, kefir.merge([artifactStream, containerEndStream]).take(1)], _.first)
            //.flatMap((containerId)=> kefir.fromPromise(dockerClient.removeContainer({ containerId })))
            .toPromise();
    }
};