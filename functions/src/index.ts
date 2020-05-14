import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as express from 'express';

require("firebase/firestore");
admin.initializeApp(functions.config().firebase)

const app = express();
// const db = admin.firestore();
app.get('/jots', (req, res) => {
    // db.collection("q41FpvsIiYV9K241Jmuc7Lt71jN2/data/jots")
    //     .orderBy('createdTime', 'desc')
    //     .get()
    //     .then((query) => {
    //         query.forEach((item) => {
    //             res.send(item.data().content)
    //         });
    //     })
    //     .catch((err) => {
    //         console.log("this is err: " + err)
    //     });
})

exports.app = functions.https.onRequest(app);

