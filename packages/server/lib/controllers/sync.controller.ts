import type { Request, Response, NextFunction } from 'express';
import type { Span } from 'dd-trace';
import type { LogLevel, NangoConnection, HTTP_VERB, Connection, IncomingFlowConfig, LastAction } from '@nangohq/shared';
import tracer from 'dd-trace';
import { getUserAccountAndEnvironmentFromSession } from '../utils/utils.js';
import {
    getEnvironmentId,
    deploy as deploySyncConfig,
    syncDataService,
    connectionService,
    getSyncs,
    verifyOwnership,
    isSyncValid,
    getSyncNamesByConnectionId,
    getSyncsByProviderConfigKey,
    SyncClient,
    updateScheduleStatus,
    updateSuccess as updateSuccessActivityLog,
    createActivityLogMessageAndEnd,
    createActivityLog,
    getAndReconcileDifferences,
    getSyncConfigsWithConnectionsByEnvironmentId,
    getProviderConfigBySyncAndAccount,
    SyncCommand,
    CommandToActivityLog,
    errorManager,
    analytics,
    AnalyticsTypes,
    ErrorSourceEnum,
    LogActionEnum,
    NangoError,
    configService,
    syncOrchestrator,
    getAttributes,
    flowService,
    getActionOrModelByEndpoint,
    getSyncsBySyncConfigId,
    updateFrequency,
    updateSyncScheduleFrequency,
    getInterval,
    findSyncByConnections,
    setFrequency,
    getEnvironmentAndAccountId,
    getSyncAndActionConfigsBySyncNameAndConfigId,
    createActivityLogMessage
} from '@nangohq/shared';
import { isErr, isOk } from '@nangohq/utils';
import { records } from '@nangohq/records';

const recordsService = {
    async deleteRecordsBySyncId(syncId: string): Promise<void> {
        await records.deleteRecordsBySyncId({ syncId });
        return;
    }
};

class SyncController {
    public async deploySync(req: Request, res: Response, next: NextFunction) {
        try {
            const {
                syncs,
                reconcile,
                debug,
                singleDeployMode
            }: { syncs: IncomingFlowConfig[]; reconcile: boolean; debug: boolean; singleDeployMode?: boolean } = req.body;
            const environmentId = getEnvironmentId(res);
            let reconcileSuccess = true;

            const { success, error, response: syncConfigDeployResult } = await deploySyncConfig(environmentId, syncs, req.body.nangoYamlBody || '', debug);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            if (reconcile) {
                const success = await getAndReconcileDifferences({
                    environmentId,
                    syncs,
                    performAction: reconcile,
                    activityLogId: syncConfigDeployResult?.activityLogId as number,
                    debug,
                    singleDeployMode
                });
                if (!success) {
                    reconcileSuccess = false;
                }
            }

            if (!reconcileSuccess) {
                res.status(500).send({ message: 'There was an error deploying syncs, please check the activity tab and report this issue to support' });

                return;
            }

            void analytics.trackByEnvironmentId(AnalyticsTypes.SYNC_DEPLOY_SUCCESS, environmentId);

            res.send(syncConfigDeployResult?.result);
        } catch (e) {
            const environmentId = getEnvironmentId(res);

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                environmentId,
                operation: LogActionEnum.SYNC_DEPLOY
            });

            next(e);
        }
    }

    public async confirmation(req: Request, res: Response, next: NextFunction) {
        try {
            const { syncs, debug, singleDeployMode }: { syncs: IncomingFlowConfig[]; reconcile: boolean; debug: boolean; singleDeployMode?: boolean } =
                req.body;
            const environmentId = getEnvironmentId(res);

            const result = await getAndReconcileDifferences({ environmentId, syncs, performAction: false, activityLogId: null, debug, singleDeployMode });

            res.send(result);
        } catch (e) {
            next(e);
        }
    }

    // to deprecate
    public async getRecords(req: Request, res: Response, next: NextFunction) {
        try {
            const { model, delta, offset, limit, sort_by, order, filter, include_nango_metadata } = req.query;
            const environmentId = getEnvironmentId(res);
            const connectionId = req.get('Connection-Id') as string;
            const providerConfigKey = req.get('Provider-Config-Key') as string;

            const {
                success,
                error,
                response: records
            } = await syncDataService.getDataRecords(
                connectionId,
                providerConfigKey,
                environmentId,
                model as string,
                delta as string,
                offset as string,
                limit as string,
                sort_by as string,
                order as 'asc' | 'desc',
                filter as LastAction,
                include_nango_metadata === 'true'
            );

            if (!success) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            res.send(records);
        } catch (e) {
            next(e);
        }
    }

    public async getAllRecords(req: Request, res: Response, next: NextFunction) {
        try {
            const { model, delta, modified_after, modifiedAfter, limit, filter, cursor, next_cursor } = req.query;
            const environmentId = getEnvironmentId(res);
            const connectionId = req.get('Connection-Id') as string;
            const providerConfigKey = req.get('Provider-Config-Key') as string;

            if (modifiedAfter) {
                const error = new NangoError('incorrect_param', { incorrect: 'modifiedAfter', correct: 'modified_after' });

                errorManager.errResFromNangoErr(res, error);
                return;
            }

            if (next_cursor) {
                const error = new NangoError('incorrect_param', { incorrect: 'next_cursor', correct: 'cursor' });

                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { success, error, response } = await syncDataService.getAllDataRecords(
                connectionId,
                providerConfigKey,
                environmentId,
                model as string,
                (delta || modified_after) as string,
                limit as string,
                filter as LastAction,
                cursor as string
            );

            if (!success || !response) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            res.send(response);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncsByParams(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }
            const { environment } = response;

            const { connection_id, provider_config_key } = req.query;

            const {
                success,
                error,
                response: connection
            } = await connectionService.getConnection(connection_id as string, provider_config_key as string, environment.id);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            if (!connection) {
                const error = new NangoError('unknown_connection', { connection_id, provider_config_key, environmentName: environment.name });
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            const syncs = await getSyncs(connection);

            res.send(syncs);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncs(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }
            const { environment } = response;

            const syncs = await getSyncConfigsWithConnectionsByEnvironmentId(environment.id);
            const flows = flowService.getAllAvailableFlows();

            res.send({ syncs, flows });
        } catch (e) {
            next(e);
        }
    }

    public async trigger(req: Request, res: Response, next: NextFunction) {
        try {
            const { syncs: syncNames, full_resync } = req.body;

            const provider_config_key: string | undefined = req.body.provider_config_key || req.get('Provider-Config-Key');
            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            const connection_id: string | undefined = req.body.connection_id || req.get('Connection-Id');

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            if (full_resync && typeof full_resync !== 'boolean') {
                res.status(400).send({ message: 'full_resync must be a boolean' });
                return;
            }

            const environmentId = getEnvironmentId(res);

            const { success, error } = await syncOrchestrator.runSyncCommand(
                recordsService,
                environmentId,
                provider_config_key,
                syncNames as string[],
                full_resync ? SyncCommand.RUN_FULL : SyncCommand.RUN,
                connection_id
            );

            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async actionOrModel(req: Request, res: Response, next: NextFunction) {
        try {
            const environmentId = getEnvironmentId(res);
            const providerConfigKey = req.get('Provider-Config-Key') as string;
            const connectionId = req.get('Connection-Id') as string;
            const path = '/' + req.params['0'];
            if (!connectionId) {
                res.status(400).send({ error: 'Missing connection id' });

                return;
            }

            if (!providerConfigKey) {
                res.status(400).send({ error: 'Missing provider config key' });

                return;
            }
            const { success, error, response: connection } = await connectionService.getConnection(connectionId, providerConfigKey, environmentId);

            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const { action, model } = await getActionOrModelByEndpoint(connection as NangoConnection, req.method as HTTP_VERB, path);
            if (action) {
                const input = req.body || req.params[1];
                req.body = {};
                req.body['action_name'] = action;
                req.body['input'] = input;
                await this.triggerAction(req, res, next);
            } else if (model) {
                req.query['model'] = model;
                await this.getAllRecords(req, res, next);
            } else {
                res.status(404).send({ message: `Unknown endpoint '${req.method} ${path}'` });
            }
        } catch (e) {
            next(e);
        }
    }

    public async triggerAction(req: Request, res: Response, next: NextFunction) {
        const active = tracer.scope().active();
        const span = tracer.startSpan('server.sync.triggerAction', {
            childOf: active as Span
        });

        const { input, action_name } = req.body;
        const environmentId = getEnvironmentId(res);
        const connectionId = req.get('Connection-Id');
        const providerConfigKey = req.get('Provider-Config-Key');
        try {
            if (!action_name || typeof action_name !== 'string') {
                res.status(400).send({ error: 'Missing action name' });

                span.finish();
                return;
            }

            if (!connectionId) {
                res.status(400).send({ error: 'Missing connection id' });

                span.finish();
                return;
            }

            if (!providerConfigKey) {
                res.status(400).send({ error: 'Missing provider config key' });

                span.finish();
                return;
            }

            const { success, error, response: connection } = await connectionService.getConnection(connectionId, providerConfigKey, environmentId);

            if (!success || !connection) {
                errorManager.errResFromNangoErr(res, error);

                span.finish();
                return;
            }

            const provider = await configService.getProviderName(providerConfigKey);

            const log = {
                level: 'info' as LogLevel,
                success: false,
                action: LogActionEnum.ACTION,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: connection.connection_id,
                provider,
                provider_config_key: connection.provider_config_key,
                environment_id: environmentId,
                operation_name: action_name
            };

            span.setTag('nango.actionName', action_name)
                .setTag('nango.connectionId', connectionId)
                .setTag('nango.environmentId', environmentId)
                .setTag('nango.providerConfigKey', providerConfigKey);

            const activityLogId = await createActivityLog(log);
            if (!activityLogId) {
                throw new NangoError('failed_to_create_activity_log');
            }

            const syncClient = await SyncClient.getInstance();

            if (!syncClient) {
                throw new NangoError('failed_to_get_sync_client');
            }

            const actionResponse = await syncClient.triggerAction({ connection, actionName: action_name, input, activityLogId, environment_id: environmentId });

            if (isOk(actionResponse)) {
                res.send(actionResponse.res);
                span.finish();

                return;
            } else {
                span.setTag('nango.error', actionResponse.err);
                errorManager.errResFromNangoErr(res, actionResponse.err);
                span.finish();

                return;
            }
        } catch (e) {
            span.setTag('nango.error', e);
            span.finish();

            next(e);
        }
    }

    public async getSyncProvider(req: Request, res: Response, next: NextFunction) {
        try {
            const environmentId = getEnvironmentId(res);
            const { syncName } = req.query;

            if (!syncName) {
                res.status(400).send({ message: 'Missing sync name!' });

                return;
            }

            const providerConfigKey = await getProviderConfigBySyncAndAccount(syncName as string, environmentId);

            res.send(providerConfigKey);
        } catch (e) {
            next(e);
        }
    }

    public async pause(req: Request, res: Response, next: NextFunction) {
        try {
            const { syncs: syncNames, provider_config_key, connection_id } = req.body;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            const environmentId = getEnvironmentId(res);

            await syncOrchestrator.runSyncCommand(
                recordsService,
                environmentId,
                provider_config_key as string,
                syncNames as string[],
                SyncCommand.PAUSE,
                connection_id
            );

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async start(req: Request, res: Response, next: NextFunction) {
        try {
            const { syncs: syncNames, provider_config_key, connection_id } = req.body;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (typeof syncNames === 'string') {
                res.status(400).send({ message: 'Syncs must be an array' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Missing sync names' });

                return;
            }

            const environmentId = getEnvironmentId(res);

            await syncOrchestrator.runSyncCommand(
                recordsService,
                environmentId,
                provider_config_key as string,
                syncNames as string[],
                SyncCommand.UNPAUSE,
                connection_id
            );

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async getSyncStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { syncs: passedSyncNames, provider_config_key, connection_id } = req.query;

            let syncNames = passedSyncNames;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!syncNames) {
                res.status(400).send({ message: 'Sync names must be passed in' });

                return;
            }

            const environmentId = getEnvironmentId(res);

            let connection: Connection | null = null;

            if (connection_id) {
                const connectionResult = await connectionService.getConnection(connection_id as string, provider_config_key as string, environmentId);
                const { success: connectionSuccess, error: connectionError } = connectionResult;
                if (!connectionSuccess || !connectionResult.response) {
                    errorManager.errResFromNangoErr(res, connectionError);
                    return;
                }

                connection = connectionResult.response;
            }

            if (syncNames === '*') {
                if (connection && connection.id) {
                    syncNames = await getSyncNamesByConnectionId(connection.id);
                } else {
                    const syncs = await getSyncsByProviderConfigKey(environmentId, provider_config_key as string);
                    syncNames = syncs.map((sync) => sync.name);
                }
            } else {
                syncNames = (syncNames as string).split(',');
            }

            const {
                success,
                error,
                response: syncsWithStatus
            } = await syncOrchestrator.getSyncStatus(environmentId, provider_config_key as string, syncNames, connection_id as string, false, connection);

            if (!success || !syncsWithStatus) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.send({ syncs: syncsWithStatus });
        } catch (e) {
            next(e);
        }
    }

    public async syncCommand(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }
            const { environment } = response;

            const { schedule_id, command, nango_connection_id, sync_id, sync_name, provider } = req.body;
            const connection = await connectionService.getConnectionById(nango_connection_id);

            const action = CommandToActivityLog[command as SyncCommand];

            const log = {
                level: 'info' as LogLevel,
                success: false,
                action,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: connection?.connection_id as string,
                provider,
                provider_config_key: connection?.provider_config_key as string,
                environment_id: environment.id,
                operation_name: sync_name
            };
            const activityLogId = await createActivityLog(log);

            if (!(await verifyOwnership(nango_connection_id, environment.id, sync_id))) {
                await createActivityLogMessage({
                    level: 'error',
                    activity_log_id: activityLogId!,
                    environment_id: environment.id,
                    timestamp: Date.now(),
                    content: `Unauthorized access to run the command: "${action}" for sync: ${sync_id}`
                });

                res.sendStatus(401);
                return;
            }

            const syncClient = await SyncClient.getInstance();

            if (!syncClient) {
                const error = new NangoError('failed_to_get_sync_client');
                errorManager.errResFromNangoErr(res, error);

                return;
            }

            const result = await syncClient.runSyncCommand({
                scheduleId: schedule_id,
                syncId: sync_id,
                command,
                activityLogId: activityLogId as number,
                environmentId: environment.id,
                providerConfigKey: connection?.provider_config_key as string,
                connectionId: connection?.connection_id as string,
                syncName: sync_name,
                nangoConnectionId: connection?.id,
                recordsService
            });

            if (isErr(result)) {
                errorManager.handleGenericError(result.err, req, res, tracer);
                return;
            }

            if (command !== SyncCommand.RUN) {
                await updateScheduleStatus(schedule_id, command, activityLogId as number, environment.id);
            }

            await createActivityLogMessageAndEnd({
                level: 'info',
                environment_id: environment.id,
                activity_log_id: activityLogId as number,
                timestamp: Date.now(),
                content: `Sync was updated with command: "${action}" for sync: ${sync_id}`
            });
            await updateSuccessActivityLog(activityLogId as number, true);

            let event = AnalyticsTypes.SYNC_RUN;

            switch (command) {
                case SyncCommand.PAUSE:
                    event = AnalyticsTypes.SYNC_PAUSE;
                    break;
                case SyncCommand.UNPAUSE:
                    event = AnalyticsTypes.SYNC_UNPAUSE;
                    break;
                case SyncCommand.RUN:
                    event = AnalyticsTypes.SYNC_RUN;
                    break;
                case SyncCommand.CANCEL:
                    event = AnalyticsTypes.SYNC_CANCEL;
                    break;
            }

            void analytics.trackByEnvironmentId(event, environment.id, {
                sync_id,
                sync_name,
                provider,
                provider_config_key: connection?.provider_config_key as string,
                connection_id: connection?.connection_id as string,
                schedule_id
            });

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async getFlowAttributes(req: Request, res: Response, next: NextFunction) {
        try {
            const { sync_name, provider_config_key } = req.query;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!sync_name) {
                res.status(400).send({ message: 'Missing sync name' });

                return;
            }

            const attributes = await getAttributes(provider_config_key as string, sync_name as string);

            res.status(200).send(attributes);
        } catch (e) {
            next(e);
        }
    }

    public async updateFrequency(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);

            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            const { environment } = response;
            const syncConfigId = req.params['syncId'];
            const { frequency } = req.body;

            if (!syncConfigId) {
                res.status(400).send({ message: 'Missing sync config id' });

                return;
            }

            if (!frequency) {
                res.status(400).send({ message: 'Missing frequency' });

                return;
            }

            const syncs = await getSyncsBySyncConfigId(environment.id, Number(syncConfigId));
            const setFrequency = `every ${frequency}`;
            for (const sync of syncs) {
                const { success: updateScheduleSuccess, error: updateScheduleError } = await updateSyncScheduleFrequency(
                    sync.id,
                    setFrequency,
                    sync.name,
                    environment.id
                );

                if (!updateScheduleSuccess) {
                    errorManager.errResFromNangoErr(res, updateScheduleError);
                    return;
                }
            }
            await updateFrequency(Number(syncConfigId), setFrequency);

            res.sendStatus(200);
        } catch (e) {
            next(e);
        }
    }

    public async deleteSync(req: Request, res: Response, next: NextFunction) {
        try {
            const syncId = req.params['syncId'];
            const { connection_id, provider_config_key } = req.query;

            if (!provider_config_key) {
                res.status(400).send({ message: 'Missing provider config key' });

                return;
            }

            if (!syncId) {
                res.status(400).send({ message: 'Missing sync id' });

                return;
            }

            if (!connection_id) {
                res.status(400).send({ message: 'Missing connection id' });

                return;
            }

            const environmentId = getEnvironmentId(res);

            const isValid = await isSyncValid(connection_id as string, provider_config_key as string, environmentId, syncId);

            if (!isValid) {
                res.status(400).send({ message: 'Invalid sync id' });

                return;
            }

            await syncOrchestrator.softDeleteSync(syncId, environmentId);

            res.sendStatus(204);
        } catch (e) {
            next(e);
        }
    }

    /**
     * PUT /sync/update-connection-frequency
     *
     * Allow users to change the default frequency value of a sync without losing the value.
     * The system will store the value inside `_nango_syncs.frequency` and update the relevant schedules.
     */
    public async updateFrequencyForConnection(req: Request, res: Response, next: NextFunction) {
        try {
            const { sync_name, provider_config_key, connection_id, frequency } = req.body;

            if (!provider_config_key || typeof provider_config_key !== 'string') {
                res.status(400).send({ message: 'provider_config_key must be a string' });
                return;
            }
            if (!sync_name || typeof sync_name !== 'string') {
                res.status(400).send({ message: 'sync_name must be a string' });
                return;
            }
            if (!connection_id || typeof connection_id !== 'string') {
                res.status(400).send({ message: 'connection_id must be a string' });
                return;
            }
            if (typeof frequency !== 'string' && frequency !== null) {
                res.status(400).send({ message: 'frequency must be a string or null' });
                return;
            }

            let newFrequency: string | undefined;
            if (frequency) {
                const { error, response } = getInterval(frequency, new Date());
                if (error || !response) {
                    res.status(400).send({ message: 'frequency must have a valid format (https://github.com/vercel/ms)' });
                    return;
                }
                newFrequency = response.interval;
            }

            const getEnv = await getEnvironmentAndAccountId(res, req);
            if (!getEnv.success || getEnv.response === null) {
                errorManager.errResFromNangoErr(res, getEnv.error);
                return;
            }
            const envId = getEnv.response.environmentId;

            const getConnection = await connectionService.getConnection(connection_id, provider_config_key, envId);
            if (!getConnection.response || getConnection.error) {
                res.status(400).send({ message: 'Invalid connection_id' });
                return;
            }
            const connection = getConnection.response;

            const syncs = await findSyncByConnections([Number(connection.id)], sync_name);
            if (syncs.length <= 0) {
                res.status(400).send({ message: 'Invalid sync_name' });
                return;
            }
            const syncId = syncs[0]!.id;

            // When "frequency === null" we revert the value stored in the sync config
            if (!newFrequency) {
                const providerId = await configService.getIdByProviderConfigKey(envId, provider_config_key);
                const syncConfigs = await getSyncAndActionConfigsBySyncNameAndConfigId(envId, providerId!, sync_name);
                if (syncConfigs.length <= 0) {
                    res.status(400).send({ message: 'Invalid sync_name' });
                    return;
                }
                newFrequency = syncConfigs[0]!.runs;
            }

            await setFrequency(syncId, frequency);

            const { success, error } = await updateSyncScheduleFrequency(syncId, newFrequency, sync_name, connection.environment_id);
            if (!success) {
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            res.status(200).send({ frequency: newFrequency });
        } catch (e) {
            next(e);
        }
    }
}

export default new SyncController();
