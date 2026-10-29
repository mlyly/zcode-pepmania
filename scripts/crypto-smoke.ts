/**
 * Smoke test for the encrypted-export envelope, runnable in Node via tsx
 * (Web Crypto is global in Node ≥ 20; no browser needed):
 *
 *   npx tsx scripts/crypto-smoke.ts
 *
 * Exercises: cipher round-trip, envelope tampering rejection, wrong-password
 * rejection, base64 helpers, and the strength estimator.
 */
import {
    decryptEnvelope,
    encryptJson,
    ENVELOPE_VERSION,
    estimatePasswordStrength,
    isEncryptedEnvelope,
} from "../lib/db/cryptography";

let failed = false;

async function expectError(label: string, fn: () => Promise<unknown>) {
    try {
        await fn();
        console.error(`✗ ${label}: expected an error but none thrown`);
        failed = true;
    } catch (error) {
        console.log(`✓ ${label}: ${error instanceof Error ? error.message : error}`);
    }
}

async function main() {
    const payload = {app: "pepmania-pwa", checksum: "abc", data: {msg: "héllo ☕"}};

    const envelope = await encryptJson(payload, "correct horse battery staple");
    if (envelope.v !== ENVELOPE_VERSION) {
        console.error("✗ envelope version mismatch");
        failed = true;
    } else {
        console.log(`✓ envelope v${envelope.v}, ${envelope.kdf.iterations} PBKDF2 iterations`);
    }

    // Round-trip.
    const plaintext = await decryptEnvelope(envelope, "correct horse battery staple");
    const roundTrip = JSON.parse(plaintext);
    const ok =
        roundTrip.app === payload.app &&
        roundTrip.checksum === payload.checksum &&
        roundTrip.data.msg === payload.data.msg;
    if (ok) console.log("✓ round-trip (incl. unicode) matches");
    else {
        console.error("✗ round-trip mismatch:", plaintext);
        failed = true;
    }

    // isEncryptedEnvelope transitions.
    if (isEncryptedEnvelope(envelope) && !isEncryptedEnvelope({}) && !isEncryptedEnvelope("x")) {
        console.log("✓ envelope detection works (plain payloads are not envelopes)");
    } else {
        console.error("✗ envelope detection broken");
        failed = true;
    }

    // Adversarial cases.
    await expectError("wrong password rejected", () =>
        decryptEnvelope(envelope, "wrong password")
    );
    await expectError("tampered ciphertext rejected", async () => {
        const flipped = {...envelope};
        // Flip a character in the base64 ciphertext.
        const c = envelope.ciphertext.replace(/a/i, "8");
        await decryptEnvelope({...flipped, ciphertext: c}, "correct horse battery staple");
    });
    await expectError("malformed envelope rejected", () =>
        decryptEnvelope({kind: "other"}, "whatever")
    );
    await expectError("empty password rejected on encrypt", () =>
        encryptJson(payload, "")
    );

    // Strength estimator sanity.
    const weak = estimatePasswordStrength("abc");
    const strong = estimatePasswordStrength("zF9#tqLw2!VbmP47");
    if (weak.score <= 1 && strong.score >= 3) {
        console.log(`✓ strength scores: "abc"=${weak.score}, strong=${strong.score}`);
    } else {
        console.error(`✗ unexpected scores weak=${weak.score} strong=${strong.score}`);
        failed = true;
    }

    if (failed) {
        console.error("\nCrypto smoke test FAILED");
        process.exit(1);
    }
    console.log("\nCrypto smoke test passed");
    process.exit(0);
}

main().catch((error) => {
    console.error("Crypto smoke test crashed:", error);
    process.exit(1);
});
