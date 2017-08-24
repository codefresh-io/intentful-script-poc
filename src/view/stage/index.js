const
    _ = require('lodash'),
    uuid = require('uuid'),
    kefir = require('kefir'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    Stream = require('stream'),
    DockerClientFactory = require('../../../lib/docker'),
    tapTestFrameworkCollect = require('./collect/standard_output_tap_test_report'),
    exitCodeTestReport = require('./collect/exit_code_test_report'),
    exitCodeCollect = require('./collect/exit_code'),
    standardOutputFilesystemCollect = require('./collect/standard_output_filesystem'),
    standardOutputLogCollect = require('./collect/standard_output_log'),
    filesystemCollect = require('./collect/filesystem');

const CONTAINER_TIMEOUT = 3600; // Seconds

const getImageForStageType = (type)=> {
    return (type.match(/^docker:(.+)/) || []).slice(1,2)[0] || _.get({
        "mocha": "nicolaspio/frontend-tools",
        "git": "bwits/docker-git-alpine",
        "mocha_node_8": "usemtech/nodejs-mocha",
        "node_6": "node:6-alpine",
        "node_8": "node:8-alpine",
        "docker": "docker:stable-dind"
    }, type, 'alpine:3.1');
};

const Importers = {
    "environment": function (registry, dockerClient, {from, variable_name}) {
        return registry.getValue(from).then((value) => ({[variable_name]: value}));
    },
    "filesystem": function (registry, dockerClient, {from, folder, _containerId}) {
        let getKeyName = (key) => registry.getBase(key).then(({type, value}) => type === "pointer" ? getKeyName(value) : key);
        return getKeyName(from).then((key) => {
            return registry.getStream(key).then((stream) => {
                return dockerClient.setFileSystemPath({containerId: _containerId, path: folder, stream}).then(() => {});
            });
        });
    }
};

const Collectors = {
    "exit_code": exitCodeCollect,
    "exit_code_test_report": exitCodeTestReport,
    "standard_output_tap_test_report": tapTestFrameworkCollect,
    "standard_output_log": standardOutputLogCollect,
    "filesystem": filesystemCollect,
    "standard_output_filesystem": standardOutputFilesystemCollect
};

const
    DOCKER_CLIENT = Symbol('DockerClient'),
    REGISTRY = Symbol('Registry');

module.exports = class extends EventEmitter {
    constructor({config, registry}) {
        super();
        Object.assign(this, {
            [REGISTRY]: registry,
            [DOCKER_CLIENT]: DockerClientFactory(config)
        });
    }

    run({type, ["import"]: _import, command}) {

        let [username, password, dockerImage] = _.at(getImageForStageType(type).match(/(((.+?):(.+?))@)?(.+)/), [3,4,5]),
            [dockerClient, registry] = [DOCKER_CLIENT, REGISTRY].map((symbol) => this[symbol]),
            containerIdProperty = kefir.concat([
                    kefir.fromPromise(dockerClient.inspectImage({ imageName: dockerImage })).ignoreValues().flatMapErrors(()=> kefir.fromPromise(dockerClient.pullImage({ imageName: dockerImage, username, password })).map((b)=> b.toString()).ignoreValues()),
                    kefir.later().flatMap(()=> kefir.fromPromise(dockerClient.createContainer({
                        cmd: ["sleep", CONTAINER_TIMEOUT.toString()],
                        name: ["cf", uuid()].join('_'),
                        image: dockerImage
                    })))
                ])
                .flatMap(({containerId}) => kefir.fromPromise(dockerClient.startContainer({containerId})).map(_.constant(containerId)))
                .toProperty();

        let environmentVariableProperty = containerIdProperty.flatMap((containerId) => {
            return kefir.combine([kefir.constant({}), ..._import.map((importConfig) =>
                kefir.fromPromise(Importers[importConfig["to"]](registry, dockerClient, _.assign(importConfig, {_containerId: containerId})))
            )], _.assign);
        }).toProperty();

        let containerEndStream = containerIdProperty
            .flatMap((containerId) => {
                return kefir
                    .fromPromise(dockerClient.attachContainer({containerId}))
                    .flatMap(({stdout}) => kefir.fromEvents(stdout, 'end').take(1));
            });

        let artifactStream = kefir
            .combine([containerIdProperty, environmentVariableProperty])
            .flatMap(([containerId, env]) => {
                return kefir
                    .concat(command.map(({run, collect}, commandIndex) => {
                        return kefir
                            .later()
                            .flatMap(() => {
                                return kefir
                                    .fromPromise(dockerClient.createExec({containerId, cmd: run, env}))
                                    .flatMap(({execId}) => kefir.fromPromise(dockerClient.startExec({execId})).map(_.partial(_.assign, {execId})))
                                    .flatMap(({stdout, stderr, execId}) => {
                                        this.emit('command_begin', { index: commandIndex });
                                        stdout.on('data', this.emit.bind(this, 'stdout'));
                                        stderr.on('data', this.emit.bind(this, 'stderr'));

                                        let commandApi = {
                                            getOutput: ()=> Promise.resolve({ stdout, stderr }),
                                            getExitCode: (function(promise){ return ()=> promise; })(kefir.fromEvents(stdout, 'end').take(1).flatMap(()=> kefir.fromPromise(dockerClient.inspectExec({ execId })).map(_.property('exit_code'))).toPromise()),
                                            getFileSystem(path = "/"){ return this.getExitCode().then(()=> dockerClient.getFileSystemPath({ containerId, path })) }
                                        };

                                        return kefir
                                            .combine(
                                                _.uniq(["exit_code", ...collect]).map((collectorObject, collectorIndex) => {
                                                    let
                                                        {alias, type = collectorObject} = collectorObject,
                                                        collector = Collectors[type] || (() => Promise.reject('Unsupported Collector'));

                                                    return kefir
                                                        .fromPromise(collector(commandApi, _.isObject(collectorObject) ? collectorObject : {}))
                                                        .flatMap((data) => {
                                                            this.emit('artifact', {
                                                                command_index: commandIndex,
                                                                collector_index: collectorIndex,
                                                                data_type: collector["data_type"],
                                                                data,
                                                                alias
                                                            });
                                                            return ((data instanceof Stream) ? kefir.fromEvents(data, 'end').take(1).map(() => true) : kefir.constant()).map(_.constant(true));
                                                        })
                                                        .map((value)=> {
                                                            this.emit('command_end', { index: commandIndex });
                                                            return value;
                                                        });
                                                })
                                            );
                                    });
                            })
                    }));
            });

        let abortStream = kefir.merge([artifactStream.last(), containerEndStream]).take(1).takeErrors(1);

        containerIdProperty
            .sampledBy(abortStream.flatMapErrors(kefir.constant))
            .onValue((containerId)=> dockerClient.removeContainer({ containerId }));

        return abortStream
            .map(_.noop)
            .toPromise();
    }
};