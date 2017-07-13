const
    _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    kefir = require('kefir'),
    util = require('util'),
    uuid = require('uuid'),
    minimist = require('minimist'),
    sampleProject = require('./data/sample_project.json'),
    Backbone = require('backbone'),
    Stream = require('stream'),
    Project = require('./src/view/project'),
    Web = require('./src/view/web');

let registryStringToObject = (value)=> value && _.zipObject(["type", "value"], Array.from(value.match(/^([a-z_]+?)\|(.*)/i)).slice(1)),
    StoreModel = Backbone.Model.extend({
        getBase: function(key){ return Promise.resolve(registryStringToObject(this.get(key))); },
        getValue: function(key){ return this.getBase(key).then(_.property('value')); },
        getStream: function(key){ return this.getValue(key).then((filename)=> fs.createReadStream(path.join(".", "data", "registry", filename))); },
        setBase: function(key, type, value){ return Promise.resolve(this.set({ [key]: [type, value].join('|') })); },
        getWriteStream: function(key, type){ let id = uuid.v4(), stream = fs.createWriteStream(path.join([".", "data", "registry", id].join('/'))); stream.once('finish',()=>{ this.setBase(key, type, id); }); return stream; },
        followKey: function(key){
            const triggerByEntry = (triggerName)=> kefir.merge([kefir.fromEvents(this, ["change", triggerName].join(':')), kefir[this.has(triggerName) ? "later" : "never"]()]).take(1);
            return triggerByEntry(key).flatMap(()=> kefir.fromPromise(this.getBase(key))).flatMap(({ type, value })=> type === "pointer" ? triggerByEntry(value) : kefir.later()).toPromise();
        }
    }),
    registry = new StoreModel(require('./data/sample_registry.json')),
    config = (function({ folder: dockerSslFolder, host: dockerHost, port: dockerPort }){
        return _.assign({
                host: dockerHost,
                port: dockerPort,
        }, ((arr)=> _.zipObject(arr, arr.map(_.flow((filename)=> [path.resolve(dockerSslFolder, filename), "pem"].join('.'), _.partial(fs.readFileSync, _, 'utf8')))))(["ca", "cert", "key"]))
    })(minimist(process.argv.slice(2), { default: { "folder": ".", "host": "localhost", "port": 2376 }, alias: { "folder": "f", "host": "h", "port": "p" }})),
    project = new Project({ registry, config });

let processStream = kefir
    .merge(["stdout", "stderr", "artifact", "stage", "command_begin", "command_end"].map((eventName)=> kefir.fromEvents(project, eventName)))
    .merge(kefir.fromEvents(project, 'error').flatMap(kefir.constantError))
    .takeUntilBy(kefir.fromEvents(project, 'end').take(1));

project.run(sampleProject);

processStream.onError((txt)=> console.warn("Error", txt.toString('utf8')));
processStream.onEnd(()=> console.log(util.inspect(registry.toJSON(), { depth: 10 })));
processStream.filter(_.matches({ type: "artifact" }))
    .map(({ data })=> data)
    .onValue(({ stage_index, command_index, collector_index, data, data_type, alias })=> {
        let keyName = ["_stage", stage_index, command_index, collector_index].join('_');
        alias && registry.setBase(alias, 'pointer', keyName);
        data instanceof Stream ? data.pipe(registry.getWriteStream(keyName, data_type)) : registry.setBase(keyName, data_type, _.isObject(data) ? JSON.stringify(data) : data);
    });

let projectSnapshot = new Backbone.Collection();

processStream
    .filter(({ type })=> ["command_begin", "command_end"].includes(type))
    .onValue(({ type, data: { index, stage_index }})=> projectSnapshot[type === "command_begin" ? "add" : "remove"]({ id: [stage_index, index].join('_') }));

processStream
    .filter(_.matches({ "type": "stage" }))
    .map(({ data: { name, index } })=> `Running stage #${index+1} -> ${name}`)
    .onValue(console.log);

let webView = new Web();