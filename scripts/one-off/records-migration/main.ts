import Knex from 'knex';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const SOURCE_DB_SCHEMA = 'nango';
const SOURCE_DB_TABLE = '_nango_sync_data_records';
const sourceKnex = Knex({
    client: 'pg',
    connection: {
        host: '*****',
        port: 5432,
        database: '*****',
        user: '*****',
        password: '*****',
        ssl: true,
        statement_timeout: 60000
    },
    pool: {
        min: 3,
        max: 6
    }
});

const TARGET_DB_SCHEMA = 'nango_records';
const TARGET_DB_TABLE = 'records';
const targetKnex = Knex({
    client: 'pg',
    connection: {
        host: 'localhost',
        port: 5432,
        database: 'nango',
        user: 'nango',
        password: 'nango',
        ssl: false,
        statement_timeout: 60000
    },
    pool: {
        min: 3,
        max: 6
    }
});

interface Checkpoint {
    lastCreatedAt: string | null;
    lastId: string | null;
}

interface TargetRecord {
    id: string;
    external_id: string;
    json: object;
    data_hash: string;
    connection_id: number;
    model: string;
    sync_id: string;
    sync_job_id: number;
    created_at_raw: string;
    created_at: string;
    updated_at: string;
    deleted_at: string;
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const checkpointFile = path.join(dirname, 'migration_checkpoint.json');

async function migrateData() {
    console.log('Starting data migration...');
    const batchSize = 1000;
    let checkpoint = await getCheckpoint();

    let more = true;
    while (more) {
        const startRead = Date.now();
        const records = await sourceKnex
            .select<TargetRecord[]>(
                sourceKnex.raw(`
                    id,
                    external_id,
                    json,
                    data_hash,
                    nango_connection_id as connection_id,
                    model,
                    sync_id,
                    sync_job_id,
                    to_json(created_at) as created_at,
                    to_json(updated_at) as updated_at,
                    to_json(external_deleted_at) as deleted_at,
                    created_at as created_at_raw
                `)
            )
            .from<TargetRecord>(`${SOURCE_DB_SCHEMA}.${SOURCE_DB_TABLE}`)
            .where((builder) => {
                if (checkpoint.lastCreatedAt && checkpoint.lastId) {
                    builder.where(sourceKnex.raw(`(created_at, id) > (?, ?)`, [checkpoint.lastCreatedAt, checkpoint.lastId]));
                }
            })
            .orderBy([
                { column: 'created_at_raw', order: 'asc' },
                { column: 'id', order: 'asc' }
            ])
            .limit(batchSize);
        const endRead = Date.now();

        if (records.length === 0) {
            console.log('No more rows to migrate');
            break;
        }
        if (records.length < batchSize) {
            more = false;
        }

        const startWrite = Date.now();
        const toInsert = records.map((record) => {
            const { created_at_raw, ...rest } = record;
            return rest;
        });
        const res = await targetKnex
            .insert(toInsert)
            .into<{ id: string; created_at: string }>(`${TARGET_DB_SCHEMA}.${TARGET_DB_TABLE}`)
            .onConflict(['connection_id', 'model', 'external_id'])
            .ignore()
            .returning(['id', 'created_at']);
        const endWrite = Date.now();

        const lastRow = records[records.length - 1];
        if (lastRow) {
            try {
                checkpoint = { lastCreatedAt: lastRow.created_at, lastId: lastRow.id };
                await saveCheckpoint(checkpoint);
                console.log(
                    `${res.length} more rows migrated (total: ${endWrite - startRead}, read: ${endRead - startRead}ms, write: ${endWrite - startWrite}ms). Checkpoint: ${JSON.stringify(checkpoint)}. `
                );
            } catch (error) {
                console.error('Error saving checkpoint:', error);
                process.exit(1);
            }
        } else {
            console.error('No last row found');
            process.exit(1);
        }
    }
    console.log('Data migration completed');
}

async function getCheckpoint(): Promise<Checkpoint> {
    try {
        const data = await fs.promises.readFile(checkpointFile, 'utf8');
        return JSON.parse(data) as Checkpoint;
    } catch (error: any) {
        if (error['code'] == 'ENOENT') {
            return { lastCreatedAt: null, lastId: null };
        }
        throw error;
    }
}

async function saveCheckpoint(checkpoint: Checkpoint) {
    await fs.promises.writeFile(checkpointFile, JSON.stringify(checkpoint));
}

// time execution
const start = new Date();
migrateData()
    .catch((error) => {
        console.error('Error occurred during data migration:', error);
    })
    .finally(async () => {
        await sourceKnex.destroy();
        await targetKnex.destroy();

        const end = new Date();
        console.log('Execution took:', (end.getTime() - start.getTime()) / 1000, 's');
    });
