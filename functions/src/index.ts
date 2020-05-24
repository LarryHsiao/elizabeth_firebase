import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as key from '../key.json';
import {google} from 'googleapis';
import {CallableContext} from 'firebase-functions/lib/providers/https';

require("firebase/firestore");

admin.initializeApp()
let firestore = admin.firestore();

const authClient = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"]
});

const playDeveloperApiClient = google.androidpublisher({
    version: 'v3',
    auth: authClient
});

exports.subVerification = functions.https.onCall(async (data, context: CallableContext) => {
    try {
        await authClient.authorize();
        const subscription = await playDeveloperApiClient.purchases.subscriptions.get({
            packageName: data.package_name,
            subscriptionId: data.sku_id,
            token: data.purchase_token
        });
        if (subscription.status === 200) {
            return {
                status: 200,
                message: "Subscription verification successfully!"
            }
        } else {
            return {
                status: 500,
                message: "Failed to verify subscription, Try again!"
            }
        }
    } catch (error) {
        console.log(error)
        return {
            status: 500,
            message: "Failed to verify subscription, Try again!"
        }
    }
});

// exports.checkSubs = functions.pubsub.schedule('0/1 0 * * *').onRun((context) => {
exports.checkSubs = functions.https.onRequest(async (req, res) => {
    firestore.collection("q41FpvsIiYV9K241Jmuc7Lt71jN2/data/jots")
        .orderBy('createdTime', 'desc')
        .get()
        .then((query) => {
            query.forEach((item) => {
                console.log(item.data())
                // res.send(item.data().content);
            });
            res.send("abc");
        })
        .catch((err) => {
                console.log("this is err: " + err)
            }
        );
    return null;
});