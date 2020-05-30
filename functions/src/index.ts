import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as key from '../key.json';
import {google} from 'googleapis';

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

export interface Subscription {
    uid: string,
    package_name: string,
    sku_id: string,
    purchase_token: string,
    changeUser: boolean
}

/**
 * Use to check the subscription status. Return error to inform user to change account for cloud functions.
 */
exports.subscribtion = functions.https.onRequest(async (req, res) => {
    try {
        const subReq = req.body as Subscription
        if (subReq.uid == undefined) {
            res.status(400)
            res.send({
                message: "Required UID"
            })
            return;
        }
        await authClient.authorize();
        const playRes = await playDeveloperApiClient.purchases.subscriptions.get({
            packageName: subReq.package_name,
            subscriptionId: subReq.sku_id,
            token: subReq.purchase_token
        });
        if (playRes.status === 200) {
            const adminOrderRef = firestore.doc(`purchases/${subReq.purchase_token}`);
            const order = await adminOrderRef.get();
            if (order.exists) {
                const existUid = await order.get("uid");
                if (existUid == subReq.uid) {
                    res.sendStatus(204)
                } else {
                    if (subReq.changeUser) {
                        await firestore.doc(`${existUid}/account/purchases/${subReq.purchase_token}`).delete();
                        await updatePremiumState(existUid);
                        const userOrderRef = firestore.doc(`${subReq.uid}/account/purchases/${subReq.purchase_token}`);
                        await userOrderRef.set(playRes.data)
                        await userOrderRef.update({
                            uid: subReq.uid,
                            productId: subReq.sku_id,
                            packageName: subReq.package_name
                        });
                        await updatePremiumState(subReq.uid)
                        await adminOrderRef.update({uid: subReq.uid})
                        res.sendStatus(204)
                    } else {
                        res.status(409)
                        res.send({
                                message: "Confirm to change account to sync. Or just log in account previous used."
                            }
                        )
                    }
                }
            } else {
                await adminOrderRef.set(playRes.data)
                await adminOrderRef.update({
                    uid: subReq.uid,
                    productId: subReq.sku_id,
                    packageName: subReq.package_name
                });
                const userOrderRef = firestore.doc(`${subReq.uid}/account/purchases/${subReq.purchase_token}`);
                await userOrderRef.set(playRes.data);
                await userOrderRef.update({
                    uid: subReq.uid,
                    productId: subReq.sku_id,
                    packageName: subReq.package_name
                });
                await updatePremiumState(subReq.uid);
                res.sendStatus(201)
            }
        } else {
            res.status(401)
            res.send({
                status: 401,
                message: "Failed to verify subscription, Try again!"
            });
        }
    } catch (error) {
        console.log(error)
        res.send({
            status: 500,
            message: "Failed to verify subscription, Try again!"
        })
    }
});

// @todo #2 Daily update/check the expire date.
// Remove data if not premium
// Disable premium if expired 30 days

async function updatePremiumState(uid: string) {
    const accountRef = firestore.doc(`${uid}/account`);
    const premium = await accountRef.collection("purchases").where("productId", "==", "premium").get();
    // @todo #1 Check for expired date
    if (premium.size > 0) {
        await accountRef.set({premium: true})
    } else {
        await accountRef.set({premium: false})
    }
}