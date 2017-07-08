const
    _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    minimist = require('minimist'),
    sampleProject = require('./data/project.json'),
    sampleRegistry = require('./data/sample_registry.json'),
    DockerClientFactory = require('./lib/docker'),
    StageFactory = require('./src/stage');

let registryResolver = (key)=> Promise.resolve(_.get(sampleRegistry, key));

let
    environmentMap = { "mocha": "codefresh/test_harness" },
    dockerClient = (function({ folder: dockerSslFolder, host: dockerHost, port: dockerPort }){
        return DockerClientFactory(
            _.assign({
                host: dockerHost,
                port: dockerPort,
            }, ((arr)=> _.zipObject(arr, arr.map(_.flow((filename)=> [path.resolve(dockerSslFolder, filename), "pem"].join('.'), _.partial(fs.readFileSync, _, 'utf8')))))(["ca", "cert", "key"]))
        );
    })(minimist(process.argv.slice(2), { default: { "folder": ".", "host": "localhost", "port": 2376 }, alias: { "folder": "f", "host": "h", "port": "p" }}));

let stage = new StageFactory({ registryResolver, dockerClient }, _.get(sampleProject, 'stage.0'));
stage.on('artifact', console.log);