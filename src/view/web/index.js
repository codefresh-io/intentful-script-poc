const
    _ = require('lodash'),
    path = require('path'),
    kefir = require('kefir'),
    express = require('express');

module.exports = class {

    constructor({ port = 8080 } = {}){
        let app = express();
        app.use(express.static(path.join(__dirname, 'public')));
        app.get('/project.json', (req, res)=> {
            res.sendFile(path.join(process.cwd(), 'data', 'sample_project.json'));
        });
        app.listen(port);
    }

};