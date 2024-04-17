import type { Request, Response, NextFunction } from 'express';
import {
    errorManager,
    initOnboarding,
    getOnboardingProgress,
    updateOnboardingProgress,
    flowService,
    SyncConfigType,
    deployPreBuilt as deployPreBuiltSyncConfig,
    syncOrchestrator,
    syncDataService,
    getOnboardingProvider,
    createOnboardingProvider,
    DEMO_GITHUB_CONFIG_KEY,
    connectionService,
    DEMO_SYNC_NAME,
    DEMO_MODEL,
    getSyncByIdAndName,
    DEFAULT_GITHUB_CLIENT_ID,
    DEFAULT_GITHUB_CLIENT_SECRET,
    SyncCommand,
    SyncStatus,
    SyncClient,
    NangoError,
    DEMO_ACTION_NAME,
    createActivityLog,
    LogActionEnum,
    analytics,
    AnalyticsTypes
} from '@nangohq/shared';
import type { CustomerFacingDataRecord, IncomingPreBuiltFlowConfig } from '@nangohq/shared';
import { getLogger, isErr } from '@nangohq/utils';
import { getUserAccountAndEnvironmentFromSession } from '../utils/utils.js';
import { records } from '@nangohq/records';

const logger = getLogger('Server.Onboarding');

interface OnboardingStatus {
    id: number;
    progress: number;
    records: CustomerFacingDataRecord[] | null;
    provider: boolean;
    connection: boolean;
    sync: boolean;
}

const recordsService = {
    async deleteRecordsBySyncId(syncId: string): Promise<void> {
        await records.deleteRecordsBySyncId({ syncId });
        return;
    }
};

class OnboardingController {
    /**
     * Start an onboarding process.
     * We create a row in the DB to store the global state and create a GitHub provider so we can launch the oauth process
     */
    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            const { user, environment, account } = response;

            if (environment.name !== 'dev') {
                res.status(400).json({ error: 'onboarding_dev_only' });
                return;
            }
            if (!DEFAULT_GITHUB_CLIENT_ID || !DEFAULT_GITHUB_CLIENT_SECRET) {
                throw new Error('missing_env_var');
            }

            void analytics.track(AnalyticsTypes.DEMO_1, account.id, { user_id: user.id });

            // Create an onboarding state to remember where user left
            const onboardingId = await initOnboarding(user.id);
            if (!onboardingId) {
                void analytics.track(AnalyticsTypes.DEMO_1_ERR, account.id, { user_id: user.id });
                res.status(500).json({
                    error: 'Failed to create onboarding'
                });
            }

            // We create a default provider if not already there
            // Because we need one to launch authorization straight away
            const provider = await getOnboardingProvider({ envId: environment.id });
            if (!provider) {
                await createOnboardingProvider({ envId: environment.id });
            }

            res.status(201).json({
                id: onboardingId
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Get the interactive demo status.
     * We use the progress stored in DB to remember "unprovable step", but most of steps relies on specific data to be present.
     * So we check if each step has been correctly achieved.
     * This is particularly useful if we retry, if some parts have failed or if the user has deleted part of the state
     */
    async status(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            const { user, environment } = response;
            if (environment.name !== 'dev') {
                res.status(400).json({ message: 'onboarding_dev_only' });
                return;
            }

            const status = await getOnboardingProgress(user.id);
            if (!status) {
                res.status(404).send({ message: 'no_onboarding' });
                return;
            }

            const payload: OnboardingStatus = {
                id: status.id,
                progress: status.progress,
                connection: false,
                provider: false,
                sync: false,
                records: null
            };
            const { connection_id: connectionId } = req.query;
            if (!connectionId || typeof connectionId !== 'string') {
                res.status(400).json({ message: 'connection_id must be a string' });
                return;
            }

            const provider = await getOnboardingProvider({ envId: environment.id });
            if (!provider) {
                payload.progress = 0;
                res.status(200).json(payload);
                return;
            } else {
                payload.provider = true;
            }

            const connectionExists = await connectionService.checkIfConnectionExists(connectionId, DEMO_GITHUB_CONFIG_KEY, environment.id);
            if (!connectionExists) {
                payload.progress = 0;
                res.status(200).json(payload);
                return;
            } else {
                payload.connection = true;
            }

            const sync = await getSyncByIdAndName(connectionExists.id, DEMO_SYNC_NAME);
            if (!sync) {
                payload.progress = 1;
                res.status(200).json(payload);
                return;
            } else {
                payload.sync = true;
                payload.progress = 3;
            }

            const getRecords = await syncDataService.getAllDataRecords(connectionId, DEMO_GITHUB_CONFIG_KEY, environment.id, DEMO_MODEL);
            if (!getRecords.success) {
                res.status(400).json({ message: 'failed_to_get_records' });
                return;
            } else {
                payload.records = getRecords.response?.records || [];
            }
            if (payload.records.length > 0) {
                payload.progress = status.progress > 4 ? status.progress : 4;
            }

            res.status(200).json(payload);
        } catch (err) {
            next(err);
        }
    }

    /**
     * Create interactive demo Sync and Action
     * The code can be found in nango-integrations/github
     */
    async deploy(req: Request, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            const { environment, account, user } = response;
            void analytics.track(AnalyticsTypes.DEMO_2, account.id, { user_id: user.id });

            const githubDemoSync = flowService.getFlow(DEMO_SYNC_NAME);
            const githubDemoAction = flowService.getFlow(DEMO_ACTION_NAME);
            if (!githubDemoSync || !githubDemoAction) {
                void analytics.track(AnalyticsTypes.DEMO_2_ERR, account.id, { user_id: user.id });
                throw new Error('failed_to_find_demo_sync');
            }

            const config: IncomingPreBuiltFlowConfig[] = [
                {
                    provider: 'github',
                    providerConfigKey: DEMO_GITHUB_CONFIG_KEY,
                    type: SyncConfigType.SYNC,
                    name: DEMO_SYNC_NAME,
                    runs: githubDemoSync.runs,
                    auto_start: githubDemoSync.auto_start === true,
                    models: githubDemoSync.returns,
                    endpoints: githubDemoSync.endpoints,
                    model_schema: JSON.stringify(githubDemoSync?.models),
                    is_public: true,
                    public_route: 'github',
                    input: ''
                },
                {
                    provider: 'github',
                    providerConfigKey: DEMO_GITHUB_CONFIG_KEY,
                    type: SyncConfigType.ACTION,
                    name: DEMO_ACTION_NAME,
                    is_public: true,
                    runs: 'every day',
                    endpoints: githubDemoAction.endpoints,
                    models: [githubDemoAction.returns as unknown as string],
                    model_schema: JSON.stringify(githubDemoAction?.models),
                    public_route: 'github',
                    input: githubDemoAction.input!
                }
            ];

            const deploy = await deployPreBuiltSyncConfig(environment.id, config, '');
            if (!deploy.success || deploy.response === null) {
                void analytics.track(AnalyticsTypes.DEMO_2_ERR, account.id, { user_id: user.id });
                errorManager.errResFromNangoErr(res, deploy.error);
                return;
            }

            await syncOrchestrator.triggerIfConnectionsExist(deploy.response.result, environment.id);

            void analytics.track(AnalyticsTypes.DEMO_2_SUCCESS, account.id, { user_id: user.id });
            res.status(200).json({ success: true });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Check the sync completion state.
     * It could be replaced by regular API calls.
     */
    async checkSyncCompletion(req: Request<unknown, unknown, { connectionId?: string }>, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);

            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            if (!req.body || !req.body.connectionId || typeof req.body.connectionId !== 'string') {
                res.status(400).json({ message: 'connection_id must be a string' });
                return;
            }

            const { environment, account, user } = response;
            void analytics.track(AnalyticsTypes.DEMO_4, account.id, { user_id: user.id });
            const {
                success,
                error,
                response: status
            } = await syncOrchestrator.getSyncStatus(environment.id, DEMO_GITHUB_CONFIG_KEY, [DEMO_SYNC_NAME], req.body.connectionId, true);

            if (!success || !status) {
                void analytics.track(AnalyticsTypes.DEMO_4_ERR, account.id, { user_id: user.id });
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            if (!status || status.length <= 0) {
                // If for any reason we don't have a sync, because of a partial state
                logger.info(`[demo] no sync were found ${environment.id}`);
                await syncOrchestrator.runSyncCommand(
                    recordsService,
                    environment.id,
                    DEMO_GITHUB_CONFIG_KEY,
                    [DEMO_SYNC_NAME],
                    SyncCommand.RUN_FULL,
                    req.body.connectionId
                );
                await syncOrchestrator.runSyncCommand(
                    recordsService,
                    environment.id,
                    DEMO_GITHUB_CONFIG_KEY,
                    [DEMO_SYNC_NAME],
                    SyncCommand.UNPAUSE,
                    req.body.connectionId
                );

                res.status(200).json({ retry: true });
                return;
            }

            const [job] = status;
            if (!job) {
                res.status(400).json({ message: 'No sync job found' });
                return;
            }

            if (!job.nextScheduledSyncAt && job.jobStatus === SyncStatus.PAUSED) {
                // If the sync has never run
                logger.info(`[demo] no job were found ${environment.id}`);
                await syncOrchestrator.runSyncCommand(
                    recordsService,
                    environment.id,
                    DEMO_GITHUB_CONFIG_KEY,
                    [DEMO_SYNC_NAME],
                    SyncCommand.RUN_FULL,
                    req.body.connectionId
                );
            }

            if (job.jobStatus === SyncStatus.SUCCESS) {
                void analytics.track(AnalyticsTypes.DEMO_4_SUCCESS, account.id, { user_id: user.id });
            }

            res.status(200).json(job);
        } catch (err) {
            next(err);
        }
    }

    /**
     * Log the progress, this is merely informative and for BI.
     */
    async updateStatus(req: Request<unknown, unknown, { progress?: number }>, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            if (response.environment.name !== 'dev') {
                res.status(400).json({ message: 'onboarding_dev_only' });
                return;
            }

            if (typeof req.body.progress !== 'number' || req.body.progress > 6 || req.body.progress < 0) {
                res.status(400).json({ message: 'Missing progress' });
                return;
            }

            const progress = req.body.progress;

            const { user, account } = response;
            const status = await getOnboardingProgress(user.id);
            if (!status) {
                res.status(404).send({ message: 'no_onboarding' });
                return;
            }

            await updateOnboardingProgress(status.id, progress);
            if (progress === 3 || progress === 6) {
                void analytics.track(AnalyticsTypes[`DEMO_${progress}`], account.id, { user_id: user.id });
            }
            if (progress === 1) {
                // Step 1 is actually deploy+frontend auth
                // Frontend is in a different API so we can't instrument it on the backend so we assume if we progress then step 1 was a success
                void analytics.track(AnalyticsTypes.DEMO_1_SUCCESS, account.id, { user_id: user.id });
            }

            res.status(200).json({
                success: true
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Trigger an action to write a test GitHub issue
     */
    async writeGithubIssue(req: Request<unknown, unknown, { connectionId?: string; title?: string }>, res: Response, next: NextFunction) {
        try {
            const { success: sessionSuccess, error: sessionError, response } = await getUserAccountAndEnvironmentFromSession(req);
            if (!sessionSuccess || response === null) {
                errorManager.errResFromNangoErr(res, sessionError);
                return;
            }

            if (response.environment.name !== 'dev') {
                res.status(400).json({ message: 'onboarding_dev_only' });
                return;
            }

            if (!req.body?.connectionId || typeof req.body.connectionId !== 'string') {
                res.status(400).json({ message: 'connection_id must be a string' });
                return;
            }
            if (!req.body?.title || typeof req.body.title !== 'string') {
                res.status(400).json({ message: 'title must be a string' });
                return;
            }

            const { environment, account, user } = response;
            void analytics.track(AnalyticsTypes.DEMO_5, account.id, { user_id: user.id });

            const syncClient = await SyncClient.getInstance();
            if (!syncClient) {
                void analytics.track(AnalyticsTypes.DEMO_5_ERR, account.id, { user_id: user.id });
                throw new NangoError('failed_to_get_sync_client');
            }

            const {
                success,
                error,
                response: connection
            } = await connectionService.getConnection(req.body.connectionId, DEMO_GITHUB_CONFIG_KEY, environment.id);
            if (!success || !connection) {
                void analytics.track(AnalyticsTypes.DEMO_5_ERR, account.id, { user_id: user.id });
                errorManager.errResFromNangoErr(res, error);
                return;
            }

            const activityLogId = await createActivityLog({
                level: 'info',
                success: false,
                action: LogActionEnum.ACTION,
                start: Date.now(),
                end: Date.now(),
                timestamp: Date.now(),
                connection_id: connection.connection_id,
                provider: 'github',
                provider_config_key: connection.provider_config_key,
                environment_id: environment.id,
                operation_name: DEMO_ACTION_NAME
            });

            if (!activityLogId) {
                throw new NangoError('failed_to_create_activity_log');
            }
            const actionResponse = await syncClient.triggerAction({
                connection,
                actionName: DEMO_ACTION_NAME,
                input: { title: req.body.title },
                activityLogId,
                environment_id: environment.id
            });

            if (isErr(actionResponse)) {
                void analytics.track(AnalyticsTypes.DEMO_5_ERR, account.id, { user_id: user.id });
                errorManager.errResFromNangoErr(res, actionResponse.err);
                return;
            }

            void analytics.track(AnalyticsTypes.DEMO_5_SUCCESS, account.id, { user_id: user.id });
            res.status(200).json({ action: actionResponse.res });
        } catch (err) {
            next(err);
        }
    }
}

export default new OnboardingController();
