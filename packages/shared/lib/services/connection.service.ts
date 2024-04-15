import jwt from 'jsonwebtoken';
import axios from 'axios';
import db, { schema } from '../db/database.js';
import analytics, { AnalyticsTypes } from '../utils/analytics.js';
import providerClientManager from '../clients/provider.client.js';
import type {
    TemplateOAuth2 as ProviderTemplateOAuth2,
    Template as ProviderTemplate,
    Config as ProviderConfig,
    AuthCredentials,
    OAuth1Credentials,
    LogAction
} from '../models/index.js';
import {
    updateAction as updateActivityLogAction,
    createActivityLogMessage,
    createActivityLogMessageAndEnd,
    updateProvider as updateProviderActivityLog,
    updateSuccess as updateSuccessActivityLog
} from '../services/activity/activity.service.js';
import { LogActionEnum } from '../models/Activity.js';
import providerClient from '../clients/provider.client.js';
import configService from '../services/config.service.js';
import syncOrchestrator from './sync/orchestrator.service.js';
import environmentService from '../services/environment.service.js';
import { getFreshOAuth2Credentials } from '../clients/oauth2.client.js';
import { NangoError, stringifyError } from '../utils/error.js';

import type { Metadata, ConnectionConfig, Connection, StoredConnection, BaseConnection, NangoConnection } from '../models/Connection.js';
import { getLogger } from '@nangohq/utils';
import type { ServiceResponse } from '../models/Generic.js';
import encryptionManager from '../utils/encryption.manager.js';
import telemetry, { LogTypes } from '../utils/telemetry.js';
import type {
    AppCredentials,
    AppStoreCredentials,
    OAuth2Credentials,
    OAuth2ClientCredentials,
    ImportedCredentials,
    ApiKeyCredentials,
    BasicApiCredentials,
    ConnectionUpsertResponse
} from '../models/Auth.js';
import { AuthModes as ProviderAuthModes, AuthOperation } from '../models/Auth.js';
import { interpolateStringFromObject, parseTokenExpirationDate, isTokenExpired, getRedisUrl } from '../utils/utils.js';
import { connectionCreated as connectionCreatedHook } from '../hooks/hooks.js';
import { Locking } from '../utils/lock/locking.js';
import { InMemoryKVStore } from '../utils/kvstore/InMemoryStore.js';
import { RedisKVStore } from '../utils/kvstore/RedisStore.js';
import type { KVStore } from '../utils/kvstore/KVStore.js';
import { CONNECTIONS_WITH_SCRIPTS_CAP_LIMIT } from '../constants.js';

const logger = getLogger('Connection');

type KeyValuePairs = Record<string, string | boolean>;

class ConnectionService {
    private locking: Locking;

    constructor(locking: Locking) {
        this.locking = locking;
    }

    public async upsertConnection(
        connectionId: string,
        providerConfigKey: string,
        provider: string,
        parsedRawCredentials: AuthCredentials,
        connectionConfig: Record<string, string | boolean>,
        environment_id: number,
        accountId: number,
        metadata?: Metadata
    ): Promise<ConnectionUpsertResponse[]> {
        const storedConnection = await this.checkIfConnectionExists(connectionId, providerConfigKey, environment_id);
        const config_id = await configService.getIdByProviderConfigKey(environment_id, providerConfigKey);

        if (storedConnection) {
            const encryptedConnection = encryptionManager.encryptConnection({
                connection_id: connectionId,
                provider_config_key: providerConfigKey,
                credentials: parsedRawCredentials,
                connection_config: connectionConfig,
                environment_id: environment_id,
                config_id: config_id as number,
                metadata: metadata || storedConnection.metadata || null
            });

            encryptedConnection.updated_at = new Date();

            await db.knex.from<StoredConnection>(`_nango_connections`).where({ id: storedConnection.id, deleted: false }).update(encryptedConnection);

            void analytics.track(AnalyticsTypes.CONNECTION_UPDATED, accountId, { provider });

            return [{ id: storedConnection.id, operation: AuthOperation.OVERRIDE }];
        }

        const [id] = await db.knex.from<StoredConnection>(`_nango_connections`).insert(
            encryptionManager.encryptConnection({
                connection_id: connectionId,
                provider_config_key: providerConfigKey,
                config_id: config_id as number,
                credentials: parsedRawCredentials,
                connection_config: connectionConfig,
                environment_id: environment_id,
                metadata: metadata || null
            }),
            ['id']
        );

        void analytics.track(AnalyticsTypes.CONNECTION_INSERTED, accountId, { provider });

        return [{ id: id.id, operation: AuthOperation.CREATION }];
    }

    public async upsertApiConnection(
        connectionId: string,
        providerConfigKey: string,
        provider: string,
        credentials: ApiKeyCredentials | BasicApiCredentials,
        connectionConfig: Record<string, string>,
        environment_id: number,
        accountId: number
    ): Promise<ConnectionUpsertResponse[]> {
        const storedConnection = await this.checkIfConnectionExists(connectionId, providerConfigKey, environment_id);
        const config_id = await configService.getIdByProviderConfigKey(environment_id, providerConfigKey);

        if (storedConnection) {
            const encryptedConnection = encryptionManager.encryptConnection({
                connection_id: connectionId,
                config_id: config_id as number,
                provider_config_key: providerConfigKey,
                credentials,
                connection_config: connectionConfig,
                environment_id
            });
            encryptedConnection.updated_at = new Date();
            await db.knex.from<StoredConnection>(`_nango_connections`).where({ id: storedConnection.id, deleted: false }).update(encryptedConnection);

            void analytics.track(AnalyticsTypes.API_CONNECTION_UPDATED, accountId, { provider });

            return [{ id: storedConnection.id, operation: AuthOperation.OVERRIDE }];
        }
        const [id] = await db.knex.from<StoredConnection>(`_nango_connections`).insert(
            encryptionManager.encryptApiConnection({
                connection_id: connectionId,
                provider_config_key: providerConfigKey,
                config_id: config_id as number,
                credentials,
                connection_config: connectionConfig,
                environment_id
            }),
            ['id']
        );

        void analytics.track(AnalyticsTypes.API_CONNECTION_INSERTED, accountId, { provider });

        return [{ id: id.id, operation: AuthOperation.CREATION }];
    }

    public async upsertUnauthConnection(
        connectionId: string,
        providerConfigKey: string,
        provider: string,
        environment_id: number,
        accountId: number
    ): Promise<ConnectionUpsertResponse[]> {
        const storedConnection = await this.checkIfConnectionExists(connectionId, providerConfigKey, environment_id);
        const config_id = await configService.getIdByProviderConfigKey(environment_id, providerConfigKey);

        if (storedConnection) {
            await db.knex
                .from<StoredConnection>(`_nango_connections`)
                .where({ id: storedConnection.id, deleted: false })
                .update({
                    connection_id: connectionId,
                    provider_config_key: providerConfigKey,
                    config_id: config_id as number,
                    updated_at: new Date()
                });

            void analytics.track(AnalyticsTypes.UNAUTH_CONNECTION_UPDATED, accountId, { provider });

            return [{ id: storedConnection.id, operation: AuthOperation.OVERRIDE }];
        }
        const [id] = await db.knex.from<StoredConnection>(`_nango_connections`).insert(
            {
                connection_id: connectionId,
                provider_config_key: providerConfigKey,
                credentials: {},
                connection_config: {},
                environment_id
            },
            ['id']
        );

        void analytics.track(AnalyticsTypes.UNAUTH_CONNECTION_INSERTED, accountId, { provider });

        return [{ id: id.id, operation: AuthOperation.CREATION }];
    }

    public async importOAuthConnection(
        connection_id: string,
        provider_config_key: string,
        provider: string,
        environmentId: number,
        accountId: number,
        parsedRawCredentials: ImportedCredentials
    ) {
        const { connection_config, metadata } = parsedRawCredentials as Partial<Pick<BaseConnection, 'metadata' | 'connection_config'>>;

        const [importedConnection] = await this.upsertConnection(
            connection_id,
            provider_config_key,
            provider,
            parsedRawCredentials,
            connection_config || {},
            environmentId,
            accountId,
            metadata || undefined
        );

        if (importedConnection) {
            await connectionCreatedHook(
                {
                    id: importedConnection?.id,
                    connection_id,
                    provider_config_key,
                    environment_id: environmentId,
                    auth_mode: ProviderAuthModes.OAuth2,
                    operation: importedConnection?.operation as AuthOperation
                },
                provider,
                null
            );
        }

        return [importedConnection];
    }

    public async importApiAuthConnection(
        connection_id: string,
        provider_config_key: string,
        provider: string,
        environmentId: number,
        accountId: number,
        credentials: BasicApiCredentials | ApiKeyCredentials
    ) {
        const connection = await this.checkIfConnectionExists(connection_id, provider_config_key, environmentId);

        if (connection) {
            throw new NangoError('connection_already_exists');
        }

        const [importedConnection] = await this.upsertApiConnection(connection_id, provider_config_key, provider, credentials, {}, environmentId, accountId);

        if (importedConnection) {
            await connectionCreatedHook(
                {
                    id: importedConnection.id,
                    connection_id,
                    provider_config_key,
                    environment_id: environmentId,
                    auth_mode: ProviderAuthModes.ApiKey,
                    operation: importedConnection.operation
                },
                provider,
                null
            );
        }

        return [importedConnection];
    }

    public async getConnectionById(
        id: number
    ): Promise<Pick<Connection, 'id' | 'connection_id' | 'provider_config_key' | 'environment_id' | 'connection_config' | 'metadata'> | null> {
        const result = await schema()
            .select('id', 'connection_id', 'provider_config_key', 'environment_id', 'connection_config', 'metadata')
            .from<StoredConnection>('_nango_connections')
            .where({ id: id, deleted: false });

        if (!result || result.length == 0 || !result[0]) {
            return null;
        }

        return result[0];
    }

    public async checkIfConnectionExists(
        connection_id: string,
        provider_config_key: string,
        environment_id: number
    ): Promise<null | { id: number; metadata: Metadata }> {
        const result = await schema().select('id', 'metadata').from<StoredConnection>('_nango_connections').where({
            connection_id,
            provider_config_key,
            environment_id,
            deleted: false
        });

        if (!result || result.length == 0 || !result[0]) {
            return null;
        }

        return result[0];
    }

    public async getConnection(connectionId: string, providerConfigKey: string, environment_id: number): Promise<ServiceResponse<Connection>> {
        if (!environment_id) {
            const error = new NangoError('missing_environment');

            return { success: false, error, response: null };
        }

        if (!connectionId) {
            const error = new NangoError('missing_connection');

            await telemetry.log(LogTypes.GET_CONNECTION_FAILURE, error.message, LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                connectionId,
                providerConfigKey
            });

            return { success: false, error, response: null };
        }

        if (!providerConfigKey) {
            const error = new NangoError('missing_provider_config');

            await telemetry.log(LogTypes.GET_CONNECTION_FAILURE, error.message, LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                connectionId,
                providerConfigKey
            });

            return { success: false, error, response: null };
        }

        const result: StoredConnection[] | null = (await schema()
            .select('*')
            .from<StoredConnection>(`_nango_connections`)
            .where({ connection_id: connectionId, provider_config_key: providerConfigKey, environment_id, deleted: false })) as unknown as StoredConnection[];

        const storedConnection = result == null || result.length == 0 ? null : result[0] || null;

        if (!storedConnection) {
            const environmentName = await environmentService.getEnvironmentName(environment_id);

            const error = new NangoError('unknown_connection', { connectionId, providerConfigKey, environmentName });

            await telemetry.log(LogTypes.GET_CONNECTION_FAILURE, error.message, LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                connectionId,
                providerConfigKey
            });

            return { success: false, error, response: null };
        }

        const connection = encryptionManager.decryptConnection(storedConnection);

        // Parse the token expiration date.
        if (connection != null) {
            const credentials = connection.credentials as OAuth1Credentials | OAuth2Credentials | AppCredentials | OAuth2ClientCredentials;
            if (credentials.type && credentials.type === ProviderAuthModes.OAuth2) {
                const creds = credentials;
                creds.expires_at = creds.expires_at != null ? parseTokenExpirationDate(creds.expires_at) : undefined;
                connection.credentials = creds;
            }

            if (credentials.type && credentials.type === ProviderAuthModes.App) {
                const creds = credentials;
                creds.expires_at = creds.expires_at != null ? parseTokenExpirationDate(creds.expires_at) : undefined;
                connection.credentials = creds;
            }

            if (credentials.type && credentials.type === ProviderAuthModes.OAuth2CC) {
                const creds = credentials;
                creds.expires_at = creds.expires_at != null ? parseTokenExpirationDate(creds.expires_at) : undefined;
                connection.credentials = creds;
            }
        }

        await this.updateLastFetched(connection?.id as number);

        return { success: true, error: null, response: connection };
    }

    public async updateConnection(connection: Connection) {
        await db.knex
            .from<StoredConnection>(`_nango_connections`)
            .where({
                connection_id: connection.connection_id,
                provider_config_key: connection.provider_config_key,
                environment_id: connection.environment_id,
                deleted: false
            })
            .update(encryptionManager.encryptConnection(connection));
    }

    public async getMetadata(connection: Connection): Promise<Record<string, string>> {
        const result = await db.knex.from<StoredConnection>(`_nango_connections`).select('metadata').where({
            connection_id: connection.connection_id,
            provider_config_key: connection.provider_config_key,
            environment_id: connection.environment_id,
            deleted: false
        });

        if (!result || result.length == 0 || !result[0]) {
            return {};
        }

        return result[0].metadata;
    }

    public async getConnectionConfig(connection: Connection): Promise<ConnectionConfig> {
        const result = await db.knex.from<StoredConnection>(`_nango_connections`).select('connection_config').where({
            connection_id: connection.connection_id,
            provider_config_key: connection.provider_config_key,
            environment_id: connection.environment_id,
            deleted: false
        });

        if (!result || result.length == 0 || !result[0]) {
            return {};
        }

        return result[0].connection_config;
    }

    public async getConnectionsByEnvironmentAndConfig(environment_id: number, providerConfigKey: string): Promise<NangoConnection[]> {
        const result = await db.knex
            .from<StoredConnection>(`_nango_connections`)
            .select('id', 'connection_id', 'provider_config_key', 'environment_id', 'connection_config')
            .where({ environment_id, provider_config_key: providerConfigKey, deleted: false });

        if (!result || result.length == 0 || !result[0]) {
            return [];
        }

        return result;
    }

    public async replaceMetadata(connection: Connection, metadata: Metadata) {
        await db.knex
            .from<StoredConnection>(`_nango_connections`)
            .where({ id: connection.id as number, deleted: false })
            .update({ metadata });
    }

    public async replaceConnectionConfig(connection: Connection, config: ConnectionConfig) {
        await db.knex
            .from<StoredConnection>(`_nango_connections`)
            .where({ id: connection.id as number, deleted: false })
            .update({ connection_config: config });
    }

    public async updateMetadata(connection: Connection, metadata: Metadata): Promise<Metadata> {
        const existingMetadata = await this.getMetadata(connection);
        const newMetadata = { ...existingMetadata, ...metadata };
        await this.replaceMetadata(connection, newMetadata);

        return newMetadata;
    }

    public async updateConnectionConfig(connection: Connection, config: ConnectionConfig): Promise<ConnectionConfig> {
        const existingConfig = await this.getConnectionConfig(connection);
        const newConfig = { ...existingConfig, ...config };
        await this.replaceConnectionConfig(connection, newConfig);

        return newConfig;
    }

    public async findConnectionsByConnectionConfigValue(key: string, value: string, environmentId: number): Promise<Connection[] | null> {
        const result = await db.knex
            .from<StoredConnection>(`_nango_connections`)
            .select('*')
            .where({ environment_id: environmentId })
            .whereRaw(`connection_config->>:key = :value AND deleted = false`, { key, value });

        if (!result || result.length == 0) {
            return null;
        }

        return result.map((connection) => encryptionManager.decryptConnection(connection) as Connection);
    }

    public async findConnectionsByMultipleConnectionConfigValues(keyValuePairs: KeyValuePairs, environmentId: number): Promise<Connection[] | null> {
        let query = db.knex.from<StoredConnection>(`_nango_connections`).select('*').where({ environment_id: environmentId });

        Object.entries(keyValuePairs).forEach(([key, value]) => {
            query = query.andWhereRaw(`connection_config->>:key = :value AND deleted = false`, { key, value });
        });

        const result = await query;

        if (!result || result.length == 0) {
            return null;
        }

        return result.map((connection) => encryptionManager.decryptConnection(connection) as Connection);
    }

    public async listConnections(
        environment_id: number,
        connectionId?: string
    ): Promise<{ id: number; connection_id: string; provider: string; created: string; metadata: Metadata }[]> {
        const queryBuilder = db.knex
            .from<Connection>(`_nango_connections`)
            .select({ id: 'id' }, { connection_id: 'connection_id' }, { provider: 'provider_config_key' }, { created: 'created_at' }, 'metadata')
            .where({ environment_id, deleted: false });
        if (connectionId) {
            queryBuilder.where({ connection_id: connectionId });
        }
        return queryBuilder;
    }

    public async getAllNames(environment_id: number): Promise<string[]> {
        const connections = await this.listConnections(environment_id);
        return [...new Set(connections.map((config) => config.connection_id))];
    }

    public async deleteConnection(connection: Connection, providerConfigKey: string, environment_id: number): Promise<number> {
        const del = await db.knex
            .from<Connection>(`_nango_connections`)
            .where({
                connection_id: connection.connection_id,
                provider_config_key: providerConfigKey,
                environment_id,
                deleted: false
            })
            .update({ deleted: true, credentials: {}, credentials_iv: null, credentials_tag: null, deleted_at: new Date() });

        await syncOrchestrator.softDeleteSyncsByConnection(connection);

        return del;
    }

    public async getConnectionCredentials(
        accountId: number,
        environmentId: number,
        connectionId: string,
        providerConfigKey: string,
        activityLogId?: number | null | undefined,
        action?: LogAction,
        instantRefresh = false
    ): Promise<ServiceResponse<Connection>> {
        if (connectionId === null) {
            const error = new NangoError('missing_connection');

            return { success: false, error, response: null };
        }

        if (providerConfigKey === null) {
            const error = new NangoError('missing_provider_config');

            return { success: false, error, response: null };
        }

        const { success, error, response: connection } = await this.getConnection(connectionId, providerConfigKey, environmentId);

        if (!success) {
            return { success, error, response: null };
        }

        if (connection === null) {
            if (activityLogId) {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId,
                    content: `Connection not found using connectionId: ${connectionId} and providerConfigKey: ${providerConfigKey} and the environment: ${environmentId}`,
                    timestamp: Date.now()
                });
            }
            const environmentName = await environmentService.getEnvironmentName(environmentId);
            const error = new NangoError('unknown_connection', { connectionId, providerConfigKey, environmentName });

            return { success: false, error, response: null };
        }

        const config: ProviderConfig | null = await configService.getProviderConfig(connection?.provider_config_key, environmentId);

        if (activityLogId) {
            await updateProviderActivityLog(activityLogId, config?.provider as string);
        }

        if (config === null) {
            if (activityLogId) {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId,
                    content: `Configuration not found using the providerConfigKey: ${providerConfigKey}, the account id: ${accountId} and the environment: ${environmentId}`,
                    timestamp: Date.now()
                });
            }

            const error = new NangoError('unknown_provider_config');
            return { success: false, error, response: null };
        }

        const template: ProviderTemplate | undefined = configService.getTemplate(config?.provider);

        if (
            connection?.credentials?.type === ProviderAuthModes.OAuth2 ||
            connection?.credentials?.type === ProviderAuthModes.App ||
            connection?.credentials?.type === ProviderAuthModes.OAuth2CC
        ) {
            const {
                success,
                error,
                response: credentials
            } = await this.refreshCredentialsIfNeeded({
                connection,
                providerConfig: config,
                template: template as ProviderTemplateOAuth2,
                activityLogId,
                environment_id: environmentId,
                instantRefresh,
                logAction: action
            });

            if (!success) {
                return { success, error, response: null };
            }

            connection.credentials = credentials as OAuth2Credentials;
        }

        return { success: true, error: null, response: connection };
    }

    public async updateLastFetched(id: number) {
        await db.knex.from<Connection>(`_nango_connections`).where({ id, deleted: false }).update({ last_fetched_at: new Date() });
    }

    // Parses and arbitrary object (e.g. a server response or a user provided auth object) into AuthCredentials.
    // Throws if values are missing/missing the input is malformed.
    public parseRawCredentials(rawCredentials: object, authMode: ProviderAuthModes): AuthCredentials {
        const rawCreds = rawCredentials as Record<string, any>;

        switch (authMode) {
            case ProviderAuthModes.OAuth2: {
                if (!rawCreds['access_token']) {
                    throw new NangoError(`incomplete_raw_credentials`);
                }

                let expiresAt: Date | undefined;

                if (rawCreds['expires_at']) {
                    expiresAt = parseTokenExpirationDate(rawCreds['expires_at']);
                } else if (rawCreds['expires_in']) {
                    expiresAt = new Date(Date.now() + Number.parseInt(rawCreds['expires_in'], 10) * 1000);
                }

                const oauth2Creds: OAuth2Credentials = {
                    type: ProviderAuthModes.OAuth2,
                    access_token: rawCreds['access_token'],
                    refresh_token: rawCreds['refresh_token'],
                    expires_at: expiresAt,
                    raw: rawCreds
                };

                return oauth2Creds;
            }

            case ProviderAuthModes.OAuth1: {
                if (!rawCreds['oauth_token'] || !rawCreds['oauth_token_secret']) {
                    throw new NangoError(`incomplete_raw_credentials`);
                }

                const oauth1Creds: OAuth1Credentials = {
                    type: ProviderAuthModes.OAuth1,
                    oauth_token: rawCreds['oauth_token'],
                    oauth_token_secret: rawCreds['oauth_token_secret'],
                    raw: rawCreds
                };

                return oauth1Creds;
            }

            case ProviderAuthModes.OAuth2CC: {
                if (!rawCreds['token']) {
                    throw new NangoError(`incomplete_raw_credentials`);
                }

                let expiresAt: Date | undefined;

                if (rawCreds['expires_at']) {
                    expiresAt = parseTokenExpirationDate(rawCreds['expires_at']);
                } else if (rawCreds['expires_in']) {
                    expiresAt = new Date(Date.now() + Number.parseInt(rawCreds['expires_in'], 10) * 1000);
                }

                const oauth2Creds: OAuth2ClientCredentials = {
                    type: ProviderAuthModes.OAuth2CC,
                    token: rawCreds['token'],
                    client_id: '',
                    client_secret: '',
                    expires_at: expiresAt,
                    raw: rawCreds
                };

                return oauth2Creds;
            }

            default:
                throw new NangoError(`Cannot parse credentials, unknown credentials type: ${JSON.stringify(rawCreds, undefined, 2)}`);
        }
    }

    public async refreshCredentialsIfNeeded({
        connection,
        providerConfig,
        template,
        activityLogId = null,
        environment_id,
        instantRefresh = false,
        logAction = 'token'
    }: {
        connection: Connection;
        providerConfig: ProviderConfig;
        template: ProviderTemplateOAuth2;
        activityLogId: number | null | undefined;
        environment_id: number;
        instantRefresh?: boolean;
        logAction?: LogAction | undefined;
    }): Promise<ServiceResponse<OAuth2Credentials | AppCredentials | AppStoreCredentials | OAuth2ClientCredentials>> {
        const connectionId = connection.connection_id;
        const credentials = connection.credentials as OAuth2Credentials;
        const providerConfigKey = connection.provider_config_key;

        const shouldRefresh = await this.shouldRefreshCredentials(connection, credentials, providerConfig, template, instantRefresh);

        if (shouldRefresh) {
            await telemetry.log(LogTypes.AUTH_TOKEN_REFRESH_START, 'Token refresh is being started', LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                connectionId,
                providerConfigKey,
                provider: providerConfig.provider
            });
            // We must ensure that only one refresh is running at a time accross all instances.
            // Using a simple redis entry as a lock with a TTL to ensure it is always released.
            // NOTES:
            // - This is not a distributed lock and will not work in a multi-redis environment.
            // - It could also be unsafe in case of a Redis crash.
            // We are using this for now as it is a simple solution that should work for most cases.
            const lockKey = `lock:refresh:${environment_id}:${providerConfigKey}:${connectionId}`;
            try {
                const ttlInMs = 10000;
                const acquitistionTimeoutMs = ttlInMs * 1.2; // giving some extra time for the lock to be released
                await this.locking.tryAcquire(lockKey, ttlInMs, acquitistionTimeoutMs);

                const { success, error, response: newCredentials } = await this.getNewCredentials(connection, providerConfig, template);
                if (!success || !newCredentials) {
                    await telemetry.log(LogTypes.AUTH_TOKEN_REFRESH_FAILURE, `Token refresh failed, ${error?.message}`, LogActionEnum.AUTH, {
                        environmentId: String(environment_id),
                        connectionId,
                        providerConfigKey,
                        provider: providerConfig.provider
                    });

                    return { success, error, response: null };
                }
                connection.credentials = newCredentials;
                await this.updateConnection(connection);

                await telemetry.log(LogTypes.AUTH_TOKEN_REFRESH_SUCCESS, 'Token refresh was successful', LogActionEnum.AUTH, {
                    environmentId: String(environment_id),
                    connectionId,
                    providerConfigKey,
                    provider: providerConfig.provider
                });

                return { success: true, error: null, response: newCredentials };
            } catch (e: any) {
                if (activityLogId && logAction === 'token') {
                    await this.logErrorActivity(activityLogId, environment_id, `Refresh oauth2 token call failed`);
                }

                const errorMessage = e.message || 'Unknown error';
                const errorDetails = {
                    message: errorMessage,
                    name: e.name || 'Error',
                    stack: e.stack || 'No stack trace'
                };

                const errorString = JSON.stringify(errorDetails);

                await telemetry.log(LogTypes.AUTH_TOKEN_REFRESH_FAILURE, `Token refresh failed, ${errorString}`, LogActionEnum.AUTH, {
                    environmentId: String(environment_id),
                    connectionId,
                    providerConfigKey,
                    provider: providerConfig.provider
                });

                const error = new NangoError('refresh_token_external_error', e as Error);

                return { success: false, error, response: null };
            } finally {
                this.locking.release(lockKey);
            }
        }

        return { success: true, error: null, response: credentials };
    }

    public async getAppStoreCredentials(
        template: ProviderTemplate,
        connectionConfig: Connection['connection_config'],
        privateKey: string
    ): Promise<ServiceResponse<AppStoreCredentials>> {
        const templateTokenUrl = typeof template.token_url === 'string' ? template.token_url : (template.token_url[ProviderAuthModes.AppStore] as string);
        const tokenUrl = interpolateStringFromObject(templateTokenUrl, { connectionConfig });

        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 15 * 60;

        const payload: Record<string, string | number> = {
            iat: now,
            exp: expiration,
            iss: connectionConfig['issuerId']
        };

        if (template.authorization_params && template.authorization_params['audience']) {
            payload['aud'] = template.authorization_params['audience'];
        }

        if (connectionConfig['scope']) {
            payload['scope'] = connectionConfig['scope'];
        }

        const {
            success,
            error,
            response: rawCredentials
        } = await this.getJWTCredentials(privateKey, tokenUrl, payload, null, {
            header: {
                alg: 'ES256',
                kid: connectionConfig['privateKeyId'],
                typ: 'JWT'
            }
        });

        if (!success || !rawCredentials) {
            return { success, error, response: null };
        }

        const credentials: AppStoreCredentials = {
            type: ProviderAuthModes.AppStore,
            access_token: rawCredentials?.token,
            private_key: Buffer.from(privateKey).toString('base64'),
            expires_at: rawCredentials?.expires_at,
            raw: rawCredentials as unknown as Record<string, unknown>
        };

        return { success: true, error: null, response: credentials };
    }

    public async getAppCredentialsAndFinishConnection(
        connectionId: string,
        integration: ProviderConfig,
        template: ProviderTemplate,
        connectionConfig: ConnectionConfig,
        activityLogId: number
    ): Promise<void> {
        const { success, error, response: credentials } = await this.getAppCredentials(template, integration, connectionConfig);

        if (!success || !credentials) {
            logger.error(error);
            return;
        }

        const accountId = await environmentService.getAccountIdFromEnvironment(integration.environment_id);

        const [updatedConnection] = await this.upsertConnection(
            connectionId,
            integration.unique_key,
            integration.provider,
            credentials as unknown as AuthCredentials,
            connectionConfig,
            integration.environment_id,
            accountId as number
        );

        if (updatedConnection) {
            await connectionCreatedHook(
                {
                    id: updatedConnection.id,
                    connection_id: connectionId,
                    provider_config_key: integration.unique_key,
                    environment_id: integration.environment_id,
                    auth_mode: ProviderAuthModes.App,
                    operation: updatedConnection.operation
                },
                integration.provider,
                activityLogId,
                // the connection is complete so we want to initiate syncs
                // the post connection script has run already because we needed to get the github handle
                { initiateSync: true, runPostConnectionScript: false }
            );
        }

        await createActivityLogMessageAndEnd({
            level: 'info',
            environment_id: integration.environment_id,
            activity_log_id: Number(activityLogId),
            content: 'App connection was approved and credentials were saved',
            timestamp: Date.now()
        });

        await updateSuccessActivityLog(Number(activityLogId), true);
    }

    public async getAppCredentials(
        template: ProviderTemplate,
        config: ProviderConfig,
        connectionConfig: Connection['connection_config']
    ): Promise<ServiceResponse<AppCredentials>> {
        const templateTokenUrl = typeof template.token_url === 'string' ? template.token_url : (template.token_url[ProviderAuthModes.App] as string);

        const tokenUrl = interpolateStringFromObject(templateTokenUrl, { connectionConfig });
        const privateKeyBase64 = config?.custom ? config.custom['private_key'] : config.oauth_client_secret;

        const privateKey = Buffer.from(privateKeyBase64 as string, 'base64').toString('utf8');

        const headers = {
            Accept: 'application/vnd.github.v3+json'
        };

        const now = Math.floor(Date.now() / 1000);
        const expiration = now + 10 * 60;

        const payload: Record<string, string | number> = {
            iat: now,
            exp: expiration,
            iss: (config?.custom ? config.custom['app_id'] : config.oauth_client_id) as string
        };

        const { success, error, response: rawCredentials } = await this.getJWTCredentials(privateKey, tokenUrl, payload, headers, { algorithm: 'RS256' });

        if (!success || !rawCredentials) {
            return { success, error, response: null };
        }

        const credentials: AppCredentials = {
            type: ProviderAuthModes.App,
            access_token: rawCredentials?.token,
            expires_at: rawCredentials?.expires_at,
            raw: rawCredentials as unknown as Record<string, unknown>
        };

        return { success: true, error: null, response: credentials };
    }

    public async getOauthClientCredentials(
        template: ProviderTemplate,
        client_id: string,
        client_secret: string
    ): Promise<ServiceResponse<OAuth2ClientCredentials>> {
        const url = template.authorization_url;
        try {
            const params = new URLSearchParams();
            params.append('client_id', client_id);
            params.append('client_secret', client_secret);

            const fullUrl = `${url}?${params}`;
            const response = await axios.post(fullUrl);

            const { data } = response;

            if (!data || !data.success) {
                return { success: false, error: new NangoError('invalid_client_credentials'), response: null };
            }

            const parsedCreds = this.parseRawCredentials(data.data, ProviderAuthModes.OAuth2CC) as OAuth2ClientCredentials;

            parsedCreds.client_id = client_id;
            parsedCreds.client_secret = client_secret;

            return { success: true, error: null, response: parsedCreds };
        } catch (e: any) {
            const errorPayload = {
                message: e.message || 'Unknown error',
                name: e.name || 'Error'
            };
            logger.error(`Error fetching client credentials ${stringifyError(e)}`);
            const error = new NangoError('client_credentials_fetch_error', errorPayload);
            return { success: false, error, response: null };
        }
    }

    public async shouldCapUsage({ providerConfigKey, environmentId }: { providerConfigKey: string; environmentId: number }): Promise<boolean> {
        const connections = await this.getConnectionsByEnvironmentAndConfig(environmentId, providerConfigKey);

        if (!connections) {
            return false;
        }

        if (connections.length >= CONNECTIONS_WITH_SCRIPTS_CAP_LIMIT) {
            logger.info(`Reached cap for providerConfigKey: ${providerConfigKey} and environmentId: ${environmentId}`);
            return true;
        }

        return false;
    }

    private async getJWTCredentials(
        privateKey: string,
        url: string,
        payload: Record<string, string | number>,
        additionalApiHeaders: Record<string, string> | null,
        options: object
    ): Promise<ServiceResponse<any>> {
        const hasLineBreak = /-----BEGIN RSA PRIVATE KEY-----\n/.test(privateKey);

        if (!hasLineBreak) {
            privateKey = privateKey.replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n');
            privateKey = privateKey.replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----');
        }

        try {
            const token = jwt.sign(payload, privateKey, options);

            const headers = {
                Authorization: `Bearer ${token}`
            };

            if (additionalApiHeaders) {
                Object.assign(headers, additionalApiHeaders);
            }

            const tokenResponse = await axios.post(
                url,
                {},
                {
                    headers
                }
            );

            return { success: true, error: null, response: tokenResponse.data };
        } catch (e: any) {
            const errorPayload = {
                message: e.message || 'Unknown error',
                name: e.name || 'Error'
            };
            const error = new NangoError('refresh_token_external_error', errorPayload);
            return { success: false, error, response: null };
        }
    }

    private async shouldRefreshCredentials(
        connection: Connection,
        credentials: OAuth2Credentials,
        providerConfig: ProviderConfig,
        template: ProviderTemplateOAuth2,
        instantRefresh: boolean
    ): Promise<boolean> {
        const refreshCondition =
            instantRefresh ||
            (providerClient.shouldIntrospectToken(providerConfig.provider) && (await providerClient.introspectedTokenExpired(providerConfig, connection)));

        let tokenExpirationCondition =
            refreshCondition || (credentials.expires_at && isTokenExpired(credentials.expires_at, template.token_expiration_buffer || 15 * 60));

        if ((template.auth_mode === ProviderAuthModes.OAuth2 || credentials?.type === ProviderAuthModes.OAuth2) && providerConfig.provider !== 'facebook') {
            tokenExpirationCondition = Boolean(credentials.refresh_token && tokenExpirationCondition);
        }

        return Boolean(tokenExpirationCondition);
    }

    private async getNewCredentials(
        connection: Connection,
        providerConfig: ProviderConfig,
        template: ProviderTemplate
    ): Promise<ServiceResponse<OAuth2Credentials | OAuth2ClientCredentials | AppCredentials | AppStoreCredentials>> {
        if (providerClientManager.shouldUseProviderClient(providerConfig.provider)) {
            const rawCreds = await providerClientManager.refreshToken(template as ProviderTemplateOAuth2, providerConfig, connection);
            const parsedCreds = this.parseRawCredentials(rawCreds, ProviderAuthModes.OAuth2) as OAuth2Credentials;

            return { success: true, error: null, response: parsedCreds };
        } else if (template.auth_mode === ProviderAuthModes.OAuth2CC) {
            const { client_id, client_secret } = connection.credentials as OAuth2ClientCredentials;
            const { success, error, response: credentials } = await this.getOauthClientCredentials(template, client_id, client_secret);

            if (!success || !credentials) {
                return { success, error, response: null };
            }

            return { success: true, error: null, response: credentials };
        } else if (template.auth_mode === ProviderAuthModes.AppStore) {
            const { private_key } = connection.credentials as AppStoreCredentials;
            const { success, error, response: credentials } = await this.getAppStoreCredentials(template, connection.connection_config, private_key);

            if (!success || !credentials) {
                return { success, error, response: null };
            }

            return { success: true, error: null, response: credentials };
        } else if (
            template.auth_mode === ProviderAuthModes.App ||
            (template.auth_mode === ProviderAuthModes.Custom && connection?.credentials?.type !== ProviderAuthModes.OAuth2)
        ) {
            const { success, error, response: credentials } = await this.getAppCredentials(template, providerConfig, connection.connection_config);

            if (!success || !credentials) {
                return { success, error, response: null };
            }

            return { success: true, error: null, response: credentials };
        } else {
            const { success, error, response: creds } = await getFreshOAuth2Credentials(connection, providerConfig, template as ProviderTemplateOAuth2);

            return { success, error, response: success ? (creds as OAuth2Credentials) : null };
        }
    }

    private async logErrorActivity(activityLogId: number, environment_id: number, message: string): Promise<void> {
        await updateActivityLogAction(activityLogId, 'token');
        await createActivityLogMessage({
            level: 'error',
            environment_id,
            activity_log_id: activityLogId,
            content: message,
            timestamp: Date.now()
        });
    }
}

const locking = await (async () => {
    let store: KVStore;
    const url = getRedisUrl();
    if (url) {
        store = new RedisKVStore(url);
        await (store as RedisKVStore).connect();
    } else {
        store = new InMemoryKVStore();
    }
    return new Locking(store);
})();

export default new ConnectionService(locking);
