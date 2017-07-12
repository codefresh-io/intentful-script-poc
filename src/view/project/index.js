const
    _ = require('lodash'),
    kefir = require('kefir'),
    Stage = require('../stage'),
    { EventEmitter } = require('events');

const
    CONFIG = Symbol('Config'),
    REGISTRY = Symbol('Registry');

module.exports = class extends EventEmitter {

    constructor({ registry, config }){
        super();
        Object.assign(this, {
            [REGISTRY]: registry,
            [CONFIG]: config
        });
    }

    run(project){

        let
            [registry, config] = [REGISTRY, CONFIG].map((symbol)=> this[symbol]),
            processStream = kefir.merge(
                project.stage.map((stageScript, stageIndex)=> {
                    let triggerEntry = stageScript["trigger"];
                    return (triggerEntry ? kefir.fromPromise(registry.followKey(triggerEntry)) : kefir.later())
                        .flatMap(()=> {
                            let
                                stage = new Stage({ config, registry }),
                                stageCompleteProperty = kefir.fromPromise(stage.run(stageScript));

                            return kefir
                                .merge([
                                    kefir.constant({ "type": "stage", "data": { "name": stageScript["name"], "index": stageIndex }}),
                                    ...["stdout", "stderr", "artifact"].map((eventName)=> kefir.fromEvents(stage, eventName).map((data)=> ({ type: eventName, data: _.assign(data, { stage_index: stageIndex }) }))),
                                    stageCompleteProperty.ignoreValues()
                                ])
                                .takeUntilBy(stageCompleteProperty);
                        });
                })
            )
            .beforeEnd(()=> ({ type: "end" }))
            .takeErrors(1);

        processStream.onError((error)=> this.emit('error', error));
        processStream.onValue((event)=> this.emit(event["type"], event));

        return this;
    }
};