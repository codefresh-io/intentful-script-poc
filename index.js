const
    _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    kefir = require('kefir'),
    minimist = require('minimist'),
    sampleProject = require('./data/project.json'),
    Backbone = require('backbone'),
    Stage = require('./src/stage'),
    { extract: tarExtractor } = require('tar-stream');

let
    store = new Backbone.Model(require('./data/sample_registry.json')),
    registryResolver = (key)=> Promise.resolve(store.get(key)),
    stageFactory = (project)=>(function({ folder: dockerSslFolder, host: dockerHost, port: dockerPort }){
        return new Stage({
            project,
            registryResolver,
            dockerClientConfiguration: _.assign({
                    host: dockerHost,
                    port: dockerPort,
                }, ((arr)=> _.zipObject(arr, arr.map(_.flow((filename)=> [path.resolve(dockerSslFolder, filename), "pem"].join('.'), _.partial(fs.readFileSync, _, 'utf8')))))(["ca", "cert", "key"])
            )
        });
    })(minimist(process.argv.slice(2), { default: { "folder": ".", "host": "localhost", "port": 2376 }, alias: { "folder": "f", "host": "h", "port": "p" }}));

let stage = stageFactory(_.get(sampleProject, 'stage.0'));
let artifactStream = kefir.fromEvents(stage, 'artifact');
artifactStream
    .filter(_.matches({ data_type: "filesystem" }))
    .flatMap(({ data })=> {
        let extractor = tarExtractor();
        data.pipe(extractor);
        return kefir
            .fromEvents(extractor, 'entry', ({ name }, stream, next)=> {
                stream.resume();
                next();
                return name;
            });
    })
    .log();