const
    _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    kefir = require('kefir'),
    uuid = require('uuid'),
    minimist = require('minimist'),
    sampleProject = require('./data/sample_project.json'),
    Backbone = require('backbone'),
    Stream = require('stream'),
    Stage = require('./src/stage'),
    { extract: tarExtractor } = require('tar-stream');

let
    store = new Backbone.Model(require('./data/sample_registry.json')),
    registry = {
        get: _.flow(store.get.bind(store), (value)=> value && _.zipObject(["type", "value"], Array.from(value.match(/^([a-z_]+?)\|(.*)/i)).slice(1)), Promise.resolve.bind(Promise)),
        getType(key){ return this.get(key).then(_.property('type')); },
        getValue(key){ return this.get(key).then(_.property('value')); },
        getStream(key){ return this.getValue(key).then((filename)=>{ console.log(filename); return fs.createReadStream(path.join(".", "data", "registry", filename)); }); },
        set: (key, type, value)=> Promise.resolve(store.set({ [key]: [type, value].join('|') })),
        getWriteStream(key, type){ let id = uuid.v4(), stream = fs.createWriteStream(path.join([".", "data", "registry", id].join('/'))); stream.once('finish',()=>{ this.set(key, type, id); }); return stream; }
    },
    stageFactory = ()=>(function({ folder: dockerSslFolder, host: dockerHost, port: dockerPort }){
        return new Stage({
            registry,
            dockerClientConfiguration: _.assign({
                    host: dockerHost,
                    port: dockerPort,
                }, ((arr)=> _.zipObject(arr, arr.map(_.flow((filename)=> [path.resolve(dockerSslFolder, filename), "pem"].join('.'), _.partial(fs.readFileSync, _, 'utf8')))))(["ca", "cert", "key"])
            )
        });
    })(minimist(process.argv.slice(2), { default: { "folder": ".", "host": "localhost", "port": 2376 }, alias: { "folder": "f", "host": "h", "port": "p" }}));

// Debug: A glance into stage run
// kefir.merge(["stdout", "stdin"].map((streamName)=> kefir.fromEvents(stage, streamName))).onValue((chunk)=> process.stdout.write(chunk));
// let artifactStream = kefir.fromEvents(stage, 'artifact');
// artifactStream.onValue(({ command_index, collector_index, data, data_type, alias })=> {
//     let keyName = ["stage", command_index, collector_index].join('_');
//     alias && registry.set(alias, 'pointer', keyName);
//     data instanceof Stream ? data.pipe(registry.getWriteStream(keyName, data_type)) : registry.set(keyName, data_type, _.isObject(data) ? JSON.stringify(data) : data);
// });

//stage.run(_.get(sampleProject, 'stage.0')).then(()=> console.log(store.toJSON()));

let prc = kefir.concat(
    sampleProject.stage.map((script)=> {
        return kefir
            .later()
            .flatMap(()=> {
                let stage = stageFactory();
                stage.on('stdout', (chunk)=> process.stdout.write(chunk));
                stage.on('stderr', (chunk)=> process.stderr.write(chunk));
                return kefir
                    .fromEvents(stage, 'artifact')
                    .takeUntilBy(kefir.fromPromise(stage.run(script)))
            });
    })
);


prc.onError((txt)=> {
    console.warn(">>>", txt.toString('utf8'));
});
prc.onValue(({ command_index, collector_index, data, data_type, alias })=> {
    //console.log(command_index, collector_index);
    //console.log(store.toJSON())
    let keyName = ["stage", uuid.v4()].join('_'); //["stage", command_index, collector_index].join('_');
    alias && registry.set(alias, 'pointer', keyName);
    data instanceof Stream ? data.pipe(registry.getWriteStream(keyName, data_type)) : registry.set(keyName, data_type, _.isObject(data) ? JSON.stringify(data) : data);
});
