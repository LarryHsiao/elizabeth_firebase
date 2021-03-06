import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as key from '../key.json';
import {androidpublisher_v3, google} from 'googleapis';
import * as express from 'express';

const PACKAGE_NAME: string = "com.larryhsiao.nyx"

require("firebase/firestore");

admin.initializeApp()
const app = express();
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

exports.dailySubCheck = functions.pubsub.schedule('0 0 * * *').onRun((() => {
    return subCheck();
}));

app.get('/subCheck', async (req, res) => {
    await subCheck();
    res.sendStatus(204);
})

async function deleteUserData(uid: string, keyHash: string) {
    await deleteCollection(firestore, `${uid}/${keyHash}/jots`, 10);
    await deleteCollection(firestore, `${uid}/${keyHash}/tag_jot`, 10);
    await deleteCollection(firestore, `${uid}/${keyHash}/tags`, 10);
    await deletePremiumData(uid, keyHash);
}

async function deletePremiumData(uid: string, keyHash: string) {
    await deleteCollection(firestore, `${uid}/${keyHash}/attachments`, 10);
    await storage.bucket().deleteFiles({prefix: `${uid}/`})
}

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
                        expiredData.uid,
                        firestore.doc(`purchases/${expired.id}`),
                        playRes.data,
                        new class implements Subscription {
                            changeUser = false
                            package_name = expiredData.packageName
                            purchase_token = expired.id
                            sku_id = expiredData.productId
                        }
                    )
                    await updatePurchaseInfo(
                        expiredData.uid,
                        firestore.doc(`${expiredData.uid}/account/purchases/${expired.id}`),
                        playRes.data,
                        new class implements Subscription {
                            changeUser = false
                            package_name = expiredData.packageName
                            purchase_token = expired.id
                            sku_id = expiredData.productId
                        }
                    )
                    await updatePremiumState(expiredData.uid)
                    return;
                }
            }
        }
        if (expiredData.expiryTimeMillis + 2592000000  /* 30days */ < currentTime) {
            let keyHash = (await firestore.doc(`${expiredData.uid}/account`).get()).get("key_hash");
            await firestore.doc(`purchases/${expired.id}`).delete()
            await firestore.doc(`${expiredData.uid}/account/purchases/${expired.id}`).delete()
            const purchases = await firestore.collection(`${expiredData.uid}/account/purchases/`).listDocuments();
            if (purchases.length == 0) {
                await deletePremiumData(expiredData.uid, keyHash);
            }
        }
        await updatePremiumState(expiredData.uid);
    })
}

app.use(async (req, res, next)=>{
    console.log('Check if request is authorized with Firebase ID token');
    if ((!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) &&
        !(req.cookies && req.cookies.__session)) {
        console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.',
            'Make sure you authorize your request by providing the following HTTP header:',
            'Authorization: Bearer <Firebase ID Token>',
            'or by passing a "__session" cookie.');
        res.status(403).send('Unauthorized');
        return;
    }
    let idToken;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        console.log('Found "Authorization" header');
        // Read the ID Token from the Authorization header.
        idToken = req.headers.authorization.split('Bearer ')[1];
    } else if(req.cookies) {
        console.log('Found "__session" cookie');
        // Read the ID Token from cookie.
        idToken = req.cookies.__session;
    } else {
        // No cookie
        res.status(403).send('Unauthorized');
        return;
    }
    try {
        const decodedIdToken = await admin.auth().verifyIdToken(idToken);
        console.log('ID Token correctly decoded', decodedIdToken);
        req.query.uid = decodedIdToken.uid;
        next();
        return;
    } catch (error) {
        console.error('Error while verifying Firebase ID token:', error);
        res.status(403).send('Unauthorized');
        return;
    }
});

export interface Subscription {
    sku_id: string,
    purchase_token: string,
    changeUser: boolean
}

/**
 * Use to check the subscription status. Return error to inform user to change account for cloud functions.
 */
app.post("/subscription", async (req, res) => {
    try {
        const sub = req.body as Subscription
        if (req.query.uid == undefined) {
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
                if (existUid == `${req.query.uid}`) {
                    res.sendStatus(204)
                } else {
                    if (sub.changeUser) {
                        await firestore.doc(`${existUid}/account/purchases/${sub.purchase_token}`).delete();
                        await updatePremiumState(existUid);
                        await updatePurchaseInfo(
                            `${req.query.uid}`,
                            firestore.doc(`${req.query.uid}/account/purchases/${sub.purchase_token}`),
                            playRes.data,
                            sub
                        )
                        await updatePremiumState(`${req.query.uid}`)
                        await adminOrderRef.update({uid: req.query.uid})
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
                await updatePurchaseInfo(`${req.query.uid}`, adminOrderRef, playRes.data, sub)
                await updatePurchaseInfo(
                    `${req.query.uid}`,
                    firestore.doc(`${req.query.uid}/account/purchases/${sub.purchase_token}`),
                    playRes.data,
                    sub
                );
                await updatePremiumState(`${req.query.uid}`);
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
        await accountRef.update({premium: true})
    } else {
        await accountRef.update({premium: false})
    }
}

async function updatePurchaseInfo(
    uid: string,
    userOrderRef: FirebaseFirestore.DocumentReference,
    data: androidpublisher_v3.Schema$SubscriptionPurchase,
    sub: Subscription
) {
    await userOrderRef.set(data);
    await userOrderRef.update({
        expiryTimeMillis: Number(data.expiryTimeMillis)
    })
    await userOrderRef.update({
        uid: uid,
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

/**
 * Request DTO for /encryptKey.
 */
export interface EncryptKeyReq {
    keyHash: string
}

/**
 * Endpoint for client to check/change encrypt key
 * which is used for encrypt user content.
 */
app.get("/encryptKey", async (req, res) => {
    const accountRef = firestore.doc(`${req.query.uid}/account`);
    const accountSnapshot = await accountRef.get();
    const keyHash = accountSnapshot.get("key_hash");
    res.status(200);
    res.send({keyHash: keyHash});
});

app.put("/encryptKey", async (req, res) => {
    const body = req.body as EncryptKeyReq;
    const accountRef = firestore.doc(`${req.query.uid}/account`);
    const currentKeyHash = (await accountRef.get()).get("key_hash");
    if (currentKeyHash == body.keyHash) {
        res.sendStatus(403);
        return
    }
    await deleteUserData(`${req.query.uid}`, currentKeyHash);
    await accountRef.update({key_hash: body.keyHash});
    res.sendStatus(204);
});

/**
 * @todo #2 Trigger for update storage usage in firestore account doc.
 */
app.get("/storageStatus", async (req, res) => {
    const [files] = await storage.bucket().getFiles({prefix: `${req.query.uid}/`})
    let usage = 0;
    for (let file of files) {
        usage = usage + parseInt(file.metadata.size);
    }
    res.status(200);
    res.send({total: usage})
})
exports.app = functions.https.onRequest(app);