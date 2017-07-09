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
    standardOutputLogCollect = require('./collect/standard_output_log');
    filesystemCollect = require('./collect/filesystem');

const CONTAINER_TIMEOUT = 160; // Seconds

const getImageForStageName = _.partial(_.get, {
    "mocha": "codefresh/test_harness"
}, _, 'alpine:3.1');

const Importers = {
    "environment": function(registryResolver, dockerClient, { from, variable_name }){
        return registryResolver(from).then((value)=>({ [variable_name]: value }));
    }
};

const Collectors = {
    "exit_code": exitCodeCollect,
    "tap_test_framework": tapTestFrameworkCollect,
    "standard_output_log": standardOutputLogCollect,
    "filesystem": filesystemCollect
};

module.exports = class extends EventEmitter {
    constructor({ dockerClientConfiguration, registryResolver, project: { type, ["import"]: _import, command }}){
        super();

        let dockerClient = DockerClientFactory(dockerClientConfiguration);

        let containerIdProperty = kefir
            .fromPromise(dockerClient.createContainer({ cmd: ["sleep", CONTAINER_TIMEOUT.toString()], name: ["cf", uuid()].join('_'), image: getImageForStageName(type) }))
            .flatMap(({ containerId })=> kefir.fromPromise(dockerClient.startContainer({ containerId })).map(_.constant(containerId)))
            .toProperty();

        let environmentVariableProperty = containerIdProperty.flatMap(()=> {
            return kefir.combine(_import.map((importConfig)=>
                kefir.fromPromise(Importers[importConfig["to"]](registryResolver, dockerClient, importConfig))
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

                                        let commandApi = {
                                            getOutput: ()=> Promise.resolve({ stdout, stderr }),
                                            getExitCode: (function(promise){ return ()=> promise; })(kefir.fromEvents(stdout, 'end').take(1).flatMap(()=> kefir.fromPromise(dockerClient.inspectExec({ execId })).map(_.property('exit_code'))).toPromise()),
                                            getFileSystem: (path = "/")=> dockerClient.getFileSystemPath({ containerId, path })
                                        };

                                        return kefir
                                            .combine(
                                                collect.map((collectorType, collectorIndex) => {
                                                    let collector = Collectors[(_.isObject(collectorType) ? collectorType.type : collectorType)] || function(){ return Promise.reject('Unsupported Collector'); };
                                                    return kefir
                                                        .fromPromise(collector(commandApi, (_.isObject(collectorType) && collectorType) || {}))
                                                        .flatMap((data)=> {
                                                            this.emit('artifact', {
                                                                command_index: commandIndex,
                                                                collector_index: collectorIndex,
                                                                data_type: collector["data_type"],
                                                                data
                                                            });
                                                            return ((data instanceof Stream) ? kefir.fromEvents(data, 'end').take(1) : kefir.constant()).map(_.constant(true));
                                                        })
                                                        .flatMapErrors((err) => {
                                                            this.emit('error', err);
                                                            return kefir.constant(false);
                                                        });


                                                    /*return kefir.fromPromise(collector(commandApi)).map((data) => {
                                                        this.emit('artifact', {
                                                            command_index: commandIndex,
                                                            collector_index: collectorIndex,
                                                            data_type: collector["data_type"],
                                                            data
                                                        });
                                                        return true;
                                                    })*/
                                                })
                                            );
                                    });
                            })
                    }))
                    .ignoreValues()
                    .ignoreErrors();
        });

        // Remove stage main container
        kefir
            .combine([containerIdProperty, kefir.merge([artifactStream, containerEndStream]).take(1)], _.first)
            .onValue((containerId)=> dockerClient.removeContainer({ containerId }).then(_.noop, _.noop));
    }
};