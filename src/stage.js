const
    _ = require('lodash'),
    uuid = require('uuid'),
    kefir = require('kefir'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    tapTestFrameworkExport = require('./export/tap_test_framework.js'),
    exitCodeExport = require('./export/exit_code.js'),
    standardOutputLogExport = require('./export/standard_output_log.js');


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
    "exit_code": exitCodeExport,
    "tap_test_framework": tapTestFrameworkExport,
    "standard_output_log": standardOutputLogExport
};

module.exports = class extends EventEmitter {
    constructor({ dockerClient, registryResolver }, { type, ["import"]: _import, command }){
        super();

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
                    .flatMap(({ stdout })=> kefir.fromEvents(stdout, 'end').take(1))
                    .map(_.constant(containerId));
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
                                            getExitCode: (function(promise){ return ()=> promise; })(kefir.fromEvents(stdout, 'end').take(1).flatMap(()=> kefir.fromPromise(dockerClient.inspectExec({ execId })).map(_.property('exit_code'))).toPromise())
                                        };

                                        return kefir
                                            .combine(
                                                collect.map((collectorType, collectorIndex) => {
                                                    return kefir.fromPromise(Collectors[collectorType](commandApi)).map((value) => {
                                                        this.emit('artifact', {
                                                            command_index: commandIndex,
                                                            collector_index: collectorIndex,
                                                            type: collectorType,
                                                            value
                                                        });
                                                        return true;
                                                    }).flatMapErrors((err) => {
                                                        this.emit('error', err);
                                                        return kefir.constant(false);
                                                    })
                                                })
                                            );
                                    });
                            })
                            //.map((artifact)=> ({ command_index: index, artifact }));
                    }));
        })
        .onValue((obj)=> console.log(util.inspect(obj, { depth: 5 })));

        containerEndStream.onValue((containerId)=> dockerClient.removeContainer({ containerId }));
    }
};