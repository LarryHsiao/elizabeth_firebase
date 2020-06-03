import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as key from '../key.json';
import {androidpublisher_v3, google} from 'googleapis';

const PACKAGE_NAME: string = "com.larryhsiao.nyx"

require("firebase/firestore");

admin.initializeApp()
const firestore = admin.firestore();
const storage = admin.storage();

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
    sku_id: string,
    purchase_token: string,
    changeUser: boolean
}

exports.dailySubCheck = functions.pubsub.schedule('0 0 * * *').onRun((() => {
    return subCheck();
}));

async function subCheck() {
    const currentTime = new Date().getTime();
    const purchasesRef = firestore.collection("purchases");
    const expires = await purchasesRef.where("expiryTimeMillis", "<", currentTime).get();
    await authClient.authorize();
    // noinspection ES6MissingAwait
    expires.forEach(async (expired) => {
        const expiredData = expired.data();
        const playRes = await playDeveloperApiClient.purchases.subscriptions.get({
            packageName: expiredData.packageName,
            subscriptionId: expiredData.productId,
            token: expired.id
        });
        if (playRes.status == 200) {
            if (playRes.data.orderId !== expired.data().orderId) {
                if (Number(playRes.data.expiryTimeMillis) > currentTime) {
                    await updatePurchaseInfo(
                        firestore.doc(`purchases/${expired.id}`),
                        playRes.data,
                        new class implements Subscription {
                            changeUser = false
                            package_name = expiredData.packageName
                            purchase_token = expired.id
                            sku_id = expiredData.productId
                            uid = expiredData.uid
                        }
                    )
                    await updatePurchaseInfo(
                        firestore.doc(`${expiredData.uid}/account/purchases/${expired.id}`),
                        playRes.data,
                        new class implements Subscription {
                            changeUser = false
                            package_name = expiredData.packageName
                            purchase_token = expired.id
                            sku_id = expiredData.productId
                            uid = expiredData.uid
                        }
                    )
                    await updatePremiumState(expiredData.uid)
                    return;
                }
            }
        }
        if (expiredData.expiryTimeMillis + 2592000000  /* 30days */ < currentTime) {
            await firestore.doc(`purchases/${expired.id}`).delete()
            await firestore.doc(`${expiredData.uid}/account/purchases/${expired.id}`).delete()
            const purchases = await firestore.collection(`${expiredData.uid}/account/purchases/`).listDocuments();
            if (purchases.length == 0) {
                await deleteCollection(firestore, `${expiredData.uid}/data/attachments`, 10);
                await deleteCollection(firestore, `${expiredData.uid}/data/jots`, 10);
                await deleteCollection(firestore, `${expiredData.uid}/data/tag_jot`, 10);
                await deleteCollection(firestore, `${expiredData.uid}/data/tags`, 10);
                await storage.bucket().deleteFiles({prefix: `${expiredData.uid}/`})
            }
        }
        await updatePremiumState(expiredData.uid);
    })
}

/**
 * Use to check the subscription status. Return error to inform user to change account for cloud functions.
 */
exports.subscribtion = functions.https.onRequest(async (req, res) => {
    try {
        const sub = req.body as Subscription
        if (sub.uid == undefined) {
            res.status(400)
            res.send({
                message: "Required UID"
            })
            return;
        }
        await authClient.authorize();
        const playRes = await playDeveloperApiClient.purchases.subscriptions.get({
            packageName: PACKAGE_NAME,
            subscriptionId: sub.sku_id,
            token: sub.purchase_token
        });
        if (playRes.status === 200) {
            const adminOrderRef = firestore.doc(`purchases/${sub.purchase_token}`);
            const order = await adminOrderRef.get();
            if (order.exists) {
                const existUid = await order.get("uid");
                if (existUid == sub.uid) {
                    res.sendStatus(204)
                } else {
                    if (sub.changeUser) {
                        await firestore.doc(`${existUid}/account/purchases/${sub.purchase_token}`).delete();
                        await updatePremiumState(existUid);
                        await updatePurchaseInfo(
                            firestore.doc(`${sub.uid}/account/purchases/${sub.purchase_token}`),
                            playRes.data,
                            sub
                        )
                        await updatePremiumState(sub.uid)
                        await adminOrderRef.update({uid: sub.uid})
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
                await updatePurchaseInfo(adminOrderRef, playRes.data, sub)
                await updatePurchaseInfo(
                    firestore.doc(`${sub.uid}/account/purchases/${sub.purchase_token}`),
                    playRes.data,
                    sub
                );
                await updatePremiumState(sub.uid);
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
        res.status(500)
        res.send({
            status: 500,
            message: "Failed to verify subscription, Try again!"
        })
    }
});

async function updatePremiumState(uid: string) {
    const accountRef = firestore.doc(`${uid}/account`);
    const premium = await accountRef.collection("purchases")
        .where("productId", "==", "premium")
        .where("expiryTimeMillis", ">", new Date().getTime())
        .get();
    if (premium.size > 0) {
        await accountRef.set({premium: true})
    } else {
        await accountRef.set({premium: false})
    }
}

async function updatePurchaseInfo(
    userOrderRef: FirebaseFirestore.DocumentReference,
    data: androidpublisher_v3.Schema$SubscriptionPurchase,
    sub: Subscription
) {
    await userOrderRef.set(data);
    await userOrderRef.update({
        expiryTimeMillis: Number(data.expiryTimeMillis)
    })
    await userOrderRef.update({
        uid: sub.uid,
        productId: sub.sku_id,
        packageName: PACKAGE_NAME
    });
}


function deleteCollection(
    db: FirebaseFirestore.Firestore,
    collectionPath: string,
    batchSize: number
) {
    let collectionRef = db.collection(collectionPath);
    let query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve, reject);
    });
}

function deleteQueryBatch(
    db: FirebaseFirestore.Firestore,
    query: FirebaseFirestore.Query,
    resolve: any,
    reject: any
) {
    query.get().then((snapshot) => {
        if (snapshot.size === 0) {
            return 0;
        }
        let batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        return batch.commit().then(() => {
            return snapshot.size;
        });
    }).then((numDeleted) => {
        if (numDeleted === 0) {
            resolve();
            return;
        }
        process.nextTick(() => {
            deleteQueryBatch(db, query, resolve, reject);
        });
    }).catch(reject);
}
