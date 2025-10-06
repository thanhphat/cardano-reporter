import { exec } from 'child_process';
import { promises as fs } from 'fs';
import axios from 'axios';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('__filename:', __filename);
console.log('__dirname:', __dirname);

// --- STEP 1: Load environment variables from .env file ---
// This must be at the very top to make variables available to the rest of the code.
dotenv.config();

// --- STEP 2: Read configuration from process.env ---
const {
    STAKE_POOL_ID,
    API_ENDPOINT,
    GENESIS_FILE,
    VRF_SKEY_FILE,
    // Note: CARDANO_NODE_SOCKET_PATH is also loaded here for cardano-cli to use
} = process.env;


// --- CONSTANTS ---
// Non-configurable constants
const NETWORK_FLAG = '--mainnet';
const LAST_EPOCH_FILE = path.resolve(__dirname, '..', 'last_epoch.txt');


/**
 * Executes a shell command and returns the output as a promise.
 * @param command The shell command to execute.
 */
function executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Command execution error: ${error.message}`);
                reject(error);
                return;
            }
            // stderr can contain useful info or warnings without being a fatal error.
            if (stderr) {
                console.warn(`Command stderr: ${stderr}`);
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Gets the current epoch number from the cardano-node.
 */
async function getCurrentEpoch(): Promise<number> {
    try {
        const output = await executeCommand(`cardano-cli query tip ${NETWORK_FLAG}`);
        const parsed = JSON.parse(output);
        if (typeof parsed.epoch !== 'number') {
            throw new Error('Epoch not found in `query tip` output');
        }
        return parsed.epoch;
    } catch (error) {
        console.error('Failed to get current epoch:', error);
        throw error;
    }
}

/**
 * Reads the last processed epoch number from a file.
 */
async function getLastProcessedEpoch(): Promise<number> {
    try {
        const data = await fs.readFile(LAST_EPOCH_FILE, 'utf-8');
        return parseInt(data.trim(), 10);
    } catch (error) {
        // If the file doesn't exist, it's the first run.
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            console.log('last_epoch.txt not found, assuming first run.');
            // Return 0 to ensure the current epoch is always greater on the first run.
            return 0;
        }
        throw error;
    }
}

/**
 * Updates the tracking file with the latest epoch number.
 * @param epoch The epoch number to save.
 */
async function updateLastProcessedEpoch(epoch: number): Promise<void> {
    await fs.writeFile(LAST_EPOCH_FILE, epoch.toString());
    console.log(`Successfully updated last processed epoch to: ${epoch}`);
}

/**
 * Fetches the leadership schedule for the current epoch.
 */
async function getLeadershipSchedule(): Promise<string> {
    // Uses variables read from the .env file.
    const command = `cardano-cli query leadership-schedule \\
        ${NETWORK_FLAG} \\
        --genesis ${GENESIS_FILE} \\
        --stake-pool-id ${STAKE_POOL_ID} \\
        --vrf-signing-key-file ${VRF_SKEY_FILE} \\
        --current`;

    console.log('Executing leadership schedule command...');
    // cardano-cli automatically reads CARDANO_NODE_SOCKET_PATH from the environment.
    return executeCommand(command);
}

/**
 * Posts the schedule data to the reporting API.
 * @param scheduleJson The leadership schedule in JSON string format.
 */
async function reportSchedule(scheduleJson: string): Promise<void> {
    try {
        // The output from cardano-cli is a JSON string; parse it before sending.
        const scheduleData = JSON.parse(scheduleJson);

        console.log(`Sending schedule to ${API_ENDPOINT}...`);
        const response = await axios.post(API_ENDPOINT!, {
            poolId: STAKE_POOL_ID,
            epoch: await getCurrentEpoch(), // Include the current epoch in the payload
            schedule: scheduleData
        });
        console.log('API response status:', response.status);
    } catch (error) {
        console.error('Failed to report schedule to API:', error instanceof Error ? error.message : error);
        if (axios.isAxiosError(error) && error.response) {
            console.error('API Response Data (error):', error.response.data);
        }
        // Re-throw the error to prevent the script from updating the last processed epoch.
        throw error;
    }
}

// --- MAIN LOGIC ---
async function main() {
    console.log(`\n--- Cardano Reporter Run @ ${new Date().toISOString()} ---`);
    try {
        const currentEpoch = await getCurrentEpoch();
        const lastProcessedEpoch = await getLastProcessedEpoch();

        console.log(`Current node epoch: ${currentEpoch}`);
        console.log(`Last processed epoch: ${lastProcessedEpoch}`);

        if (currentEpoch > lastProcessedEpoch) {
            console.log(`New epoch detected! Processing for epoch ${currentEpoch}...`);

            const schedule = await getLeadershipSchedule();
            console.log('Successfully fetched leadership schedule.');

            await reportSchedule(schedule);
            console.log('Successfully reported schedule to API.');

            await updateLastProcessedEpoch(currentEpoch);

        } else {
            console.log('No new epoch detected. Exiting.');
        }
        console.log('--- Run Finished ---');
    } catch (error) {
        console.error('An error occurred during the main process:', error instanceof Error ? error.message : error);
        console.log('--- Run Finished with Errors ---');
        process.exit(1); // Exit with an error code for cron/logging purposes
    }
}

main();