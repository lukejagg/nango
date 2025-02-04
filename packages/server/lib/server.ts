import './tracer.js';
import './utils/config.js';
import bodyParser from 'body-parser';
import multer from 'multer';
import oauthController from './controllers/oauth.controller.js';
import configController from './controllers/config.controller.js';
import providerController from './controllers/provider.controller.js';
import connectionController from './controllers/connection.controller.js';
import authController from './controllers/auth.controller.js';
import unAuthController from './controllers/unauth.controller.js';
import appStoreAuthController from './controllers/appStoreAuth.controller.js';
import authMiddleware from './middleware/access.middleware.js';
import userController from './controllers/user.controller.js';
import proxyController from './controllers/proxy.controller.js';
import activityController from './controllers/activity.controller.js';
import syncController from './controllers/sync.controller.js';
import flowController from './controllers/flow.controller.js';
import apiAuthController from './controllers/apiAuth.controller.js';
import appAuthController from './controllers/appAuth.controller.js';
import onboardingController from './controllers/onboarding.controller.js';
import webhookController from './controllers/webhook.controller.js';
import { rateLimiterMiddleware } from './middleware/ratelimit.middleware.js';
import { authCheck } from './middleware/resource-capping.middleware.js';
import path from 'path';
import { dirname } from './utils/utils.js';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { setupAuth } from './clients/auth.client.js';
import publisher from './clients/publisher.client.js';
import passport from 'passport';
import environmentController from './controllers/environment.controller.js';
import accountController from './controllers/account.controller.js';
import type { Response, Request } from 'express';
import { isCloud, isEnterprise, AUTH_ENABLED, MANAGED_AUTH_ENABLED, isBasicAuthEnabled, getLogger } from '@nangohq/utils';
import { getGlobalOAuthCallbackUrl, environmentService, getPort, errorManager, getWebsocketsPath, packageJsonFile } from '@nangohq/shared';
import oAuthSessionService from './services/oauth-session.service.js';
import migrate from './utils/migrate.js';
import { migrate as migrateRecords } from '@nangohq/records';
import tracer from 'dd-trace';

const { NANGO_MIGRATE_AT_START = 'true' } = process.env;

const logger = getLogger('Server');

const app = express();

const apiAuth = [authMiddleware.secretKeyAuth.bind(authMiddleware), rateLimiterMiddleware];
const adminAuth = [authMiddleware.secretKeyAuth.bind(authMiddleware), authMiddleware.adminKeyAuth.bind(authMiddleware), rateLimiterMiddleware];
const apiPublicAuth = [authMiddleware.publicKeyAuth.bind(authMiddleware), authCheck, rateLimiterMiddleware];
const webAuth =
    isCloud || isEnterprise
        ? [passport.authenticate('session'), authMiddleware.sessionAuth.bind(authMiddleware), rateLimiterMiddleware]
        : isBasicAuthEnabled
          ? [passport.authenticate('basic', { session: false }), authMiddleware.basicAuth.bind(authMiddleware), rateLimiterMiddleware]
          : [authMiddleware.noAuth.bind(authMiddleware), rateLimiterMiddleware];

app.use(
    express.json({
        limit: '75mb',
        verify: (req: Request, _, buf) => {
            req.rawBody = buf.toString();
        }
    })
);
app.use(bodyParser.raw({ type: 'text/xml' }));
app.use(cors());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// Set to 'false' to disable migration at startup. Appropriate when you
// have multiple replicas of the service running and you do not want them
// all trying to migrate the database at the same time. In this case, the
// operator should run migrate.ts once before starting the service.
if (NANGO_MIGRATE_AT_START === 'true') {
    await migrate();
    await migrateRecords();
} else {
    logger.info('Not migrating database');
}

await environmentService.cacheSecrets();
await oAuthSessionService.clearStaleSessions();

// API routes (no/public auth).
app.get('/health', (_, res) => {
    res.status(200).send({ result: 'ok' });
});

app.route('/oauth/callback').get(oauthController.oauthCallback.bind(oauthController));
app.route('/webhook/:environmentUuid/:providerConfigKey').post(webhookController.receive.bind(proxyController));
app.route('/app-auth/connect').get(appAuthController.connect.bind(appAuthController));
app.route('/oauth/connect/:providerConfigKey').get(apiPublicAuth, oauthController.oauthRequest.bind(oauthController));
app.route('/oauth2/auth/:providerConfigKey').post(apiPublicAuth, oauthController.oauth2RequestCC.bind(oauthController));
app.route('/api-auth/api-key/:providerConfigKey').post(apiPublicAuth, apiAuthController.apiKey.bind(apiAuthController));
app.route('/api-auth/basic/:providerConfigKey').post(apiPublicAuth, apiAuthController.basic.bind(apiAuthController));
app.route('/app-store-auth/:providerConfigKey').post(apiPublicAuth, appStoreAuthController.auth.bind(appStoreAuthController));
app.route('/unauth/:providerConfigKey').post(apiPublicAuth, unAuthController.create.bind(unAuthController));

// API Admin routes
app.route('/admin/flow/deploy/pre-built').post(adminAuth, flowController.adminDeployPrivateFlow.bind(flowController));
app.route('/admin/customer').patch(adminAuth, accountController.editCustomer.bind(accountController));

// API routes (API key auth).
app.route('/provider').get(apiAuth, providerController.listProviders.bind(providerController));
app.route('/provider/:provider').get(apiAuth, providerController.getProvider.bind(providerController));
app.route('/config').get(apiAuth, configController.listProviderConfigs.bind(configController));
app.route('/config/:providerConfigKey').get(apiAuth, configController.getProviderConfig.bind(configController));
app.route('/config').post(apiAuth, configController.createProviderConfig.bind(configController));
app.route('/config').put(apiAuth, configController.editProviderConfig.bind(configController));
app.route('/config/:providerConfigKey').delete(apiAuth, configController.deleteProviderConfig.bind(configController));
app.route('/connection/:connectionId').get(apiAuth, connectionController.getConnectionCreds.bind(connectionController));
app.route('/connection').get(apiAuth, connectionController.listConnections.bind(connectionController));
app.route('/connection/:connectionId').delete(apiAuth, connectionController.deleteConnection.bind(connectionController));
app.route('/connection/:connectionId/metadata').post(apiAuth, connectionController.setMetadata.bind(connectionController));
app.route('/connection/:connectionId/metadata').patch(apiAuth, connectionController.updateMetadata.bind(connectionController));
app.route('/connection').post(apiAuth, connectionController.createConnection.bind(connectionController));
app.route('/environment-variables').get(apiAuth, environmentController.getEnvironmentVariables.bind(connectionController));
app.route('/sync/deploy').post(apiAuth, syncController.deploySync.bind(syncController));
app.route('/sync/deploy/confirmation').post(apiAuth, syncController.confirmation.bind(syncController));
app.route('/sync/update-connection-frequency').put(apiAuth, syncController.updateFrequencyForConnection.bind(syncController));
app.route('/sync/records').get(apiAuth, syncController.getRecords.bind(syncController)); //TODO: to deprecate
app.route('/records').get(apiAuth, syncController.getAllRecords.bind(syncController));
app.route('/sync/trigger').post(apiAuth, syncController.trigger.bind(syncController));
app.route('/sync/pause').post(apiAuth, syncController.pause.bind(syncController));
app.route('/sync/start').post(apiAuth, syncController.start.bind(syncController));
app.route('/sync/provider').get(apiAuth, syncController.getSyncProvider.bind(syncController));
app.route('/sync/status').get(apiAuth, syncController.getSyncStatus.bind(syncController));
app.route('/sync/:syncId').delete(apiAuth, syncController.deleteSync.bind(syncController));
app.route('/flow/attributes').get(apiAuth, syncController.getFlowAttributes.bind(syncController));
app.route('/flow/configs').get(apiAuth, flowController.getFlowConfig.bind(flowController));
app.route('/scripts/config').get(apiAuth, flowController.getFlowConfig.bind(flowController));
app.route('/action/trigger').post(apiAuth, syncController.triggerAction.bind(syncController)); //TODO: to deprecate

app.route('/v1/*').all(apiAuth, syncController.actionOrModel.bind(syncController));

app.route('/proxy/*').all(apiAuth, upload.any(), proxyController.routeCall.bind(proxyController));

// Webapp routes (session auth).
const web = express.Router();
setupAuth(web);

// Webapp routes (no auth).
if (AUTH_ENABLED) {
    web.route('/api/v1/signup').post(rateLimiterMiddleware, authController.signup.bind(authController));
    web.route('/api/v1/signup/invite').get(rateLimiterMiddleware, authController.invitation.bind(authController));
    web.route('/api/v1/logout').post(rateLimiterMiddleware, authController.logout.bind(authController));
    web.route('/api/v1/signin').post(rateLimiterMiddleware, passport.authenticate('local'), authController.signin.bind(authController));
    web.route('/api/v1/forgot-password').put(rateLimiterMiddleware, authController.forgotPassword.bind(authController));
    web.route('/api/v1/reset-password').put(rateLimiterMiddleware, authController.resetPassword.bind(authController));
}

if (MANAGED_AUTH_ENABLED) {
    web.route('/api/v1/managed/signup').post(rateLimiterMiddleware, authController.getManagedLogin.bind(authController));
    web.route('/api/v1/managed/signup/:token').post(rateLimiterMiddleware, authController.getManagedLoginWithInvite.bind(authController));
    web.route('/api/v1/login/callback').get(rateLimiterMiddleware, authController.loginCallback.bind(authController));
}

web.route('/api/v1/meta').get(webAuth, environmentController.meta.bind(environmentController));
web.route('/api/v1/account').get(webAuth, accountController.getAccount.bind(accountController));
web.route('/api/v1/account').put(webAuth, accountController.editAccount.bind(accountController));
web.route('/api/v1/account/admin/switch').post(webAuth, accountController.switchAccount.bind(accountController));

web.route('/api/v1/environment').get(webAuth, environmentController.getEnvironment.bind(environmentController));
web.route('/api/v1/environment/callback').post(webAuth, environmentController.updateCallback.bind(environmentController));
web.route('/api/v1/environment/webhook').post(webAuth, environmentController.updateWebhookURL.bind(environmentController));
web.route('/api/v1/environment/hmac').get(webAuth, environmentController.getHmacDigest.bind(environmentController));
web.route('/api/v1/environment/hmac-enabled').post(webAuth, environmentController.updateHmacEnabled.bind(environmentController));
web.route('/api/v1/environment/webhook-send').post(webAuth, environmentController.updateAlwaysSendWebhook.bind(environmentController));
web.route('/api/v1/environment/webhook-auth-send').post(webAuth, environmentController.updateSendAuthWebhook.bind(environmentController));
web.route('/api/v1/environment/slack-notifications-enabled').post(webAuth, environmentController.updateSlackNotificationsEnabled.bind(environmentController));
web.route('/api/v1/environment/hmac-key').post(webAuth, environmentController.updateHmacKey.bind(environmentController));
web.route('/api/v1/environment/environment-variables').post(webAuth, environmentController.updateEnvironmentVariables.bind(environmentController));
web.route('/api/v1/environment/rotate-key').post(webAuth, environmentController.rotateKey.bind(accountController));
web.route('/api/v1/environment/revert-key').post(webAuth, environmentController.revertKey.bind(accountController));
web.route('/api/v1/environment/activate-key').post(webAuth, environmentController.activateKey.bind(accountController));
web.route('/api/v1/environment/admin-auth').get(webAuth, environmentController.getAdminAuthInfo.bind(environmentController));

web.route('/api/v1/integration').get(webAuth, configController.listProviderConfigsWeb.bind(configController));
web.route('/api/v1/integration/:providerConfigKey').get(webAuth, configController.getProviderConfig.bind(configController));
web.route('/api/v1/integration').put(webAuth, configController.editProviderConfigWeb.bind(connectionController));
web.route('/api/v1/integration/name').put(webAuth, configController.editProviderConfigName.bind(connectionController));
web.route('/api/v1/integration').post(webAuth, configController.createProviderConfig.bind(configController));
web.route('/api/v1/integration/new').post(webAuth, configController.createEmptyProviderConfig.bind(configController));
web.route('/api/v1/integration/:providerConfigKey').delete(webAuth, configController.deleteProviderConfig.bind(connectionController));
web.route('/api/v1/integration/:providerConfigKey/endpoints').get(webAuth, flowController.getEndpoints.bind(connectionController));
web.route('/api/v1/integration/:providerConfigKey/connections').get(webAuth, configController.getConnections.bind(connectionController));

web.route('/api/v1/provider').get(configController.listProvidersFromYaml.bind(configController));

web.route('/api/v1/connection').get(webAuth, connectionController.listConnections.bind(connectionController));
web.route('/api/v1/connection/:connectionId').get(webAuth, connectionController.getConnectionWeb.bind(connectionController));
web.route('/api/v1/connection/:connectionId').delete(webAuth, connectionController.deleteConnection.bind(connectionController));
web.route('/api/v1/connection/admin/:connectionId').delete(webAuth, connectionController.deleteAdminConnection.bind(connectionController));

web.route('/api/v1/user').get(webAuth, userController.getUser.bind(userController));
web.route('/api/v1/user/name').put(webAuth, userController.editName.bind(userController));
web.route('/api/v1/user/password').put(webAuth, userController.editPassword.bind(userController));
web.route('/api/v1/users/:userId/suspend').post(webAuth, userController.suspend.bind(userController));
web.route('/api/v1/users/invite').post(webAuth, userController.invite.bind(userController));

web.route('/api/v1/activity').get(webAuth, activityController.retrieve.bind(activityController));
web.route('/api/v1/activity-messages').get(webAuth, activityController.getMessages.bind(activityController));
web.route('/api/v1/activity-filters').get(webAuth, activityController.getPossibleFilters.bind(activityController));

web.route('/api/v1/sync').get(webAuth, syncController.getSyncsByParams.bind(syncController));
web.route('/api/v1/sync/command').post(webAuth, syncController.syncCommand.bind(syncController));
web.route('/api/v1/syncs').get(webAuth, syncController.getSyncs.bind(syncController));
web.route('/api/v1/sync/:syncId/frequency').put(webAuth, syncController.updateFrequency.bind(syncController));
web.route('/api/v1/flows').get(webAuth, flowController.getFlows.bind(syncController));
web.route('/api/v1/flow/deploy/pre-built').post(webAuth, flowController.deployPreBuiltFlow.bind(flowController));
web.route('/api/v1/flow/download').post(webAuth, flowController.downloadFlow.bind(flowController));
web.route('/api/v1/flow/:id').delete(webAuth, flowController.deleteFlow.bind(flowController));
web.route('/api/v1/flow/:flowName').get(webAuth, flowController.getFlow.bind(syncController));

web.route('/api/v1/onboarding').get(webAuth, onboardingController.status.bind(onboardingController));
web.route('/api/v1/onboarding').post(webAuth, onboardingController.create.bind(onboardingController));
web.route('/api/v1/onboarding').put(webAuth, onboardingController.updateStatus.bind(onboardingController));
web.route('/api/v1/onboarding/deploy').post(webAuth, onboardingController.deploy.bind(onboardingController));
web.route('/api/v1/onboarding/sync-status').post(webAuth, onboardingController.checkSyncCompletion.bind(onboardingController));
web.route('/api/v1/onboarding/action').post(webAuth, onboardingController.writeGithubIssue.bind(onboardingController));

// Hosted signin
if (!isCloud && !isEnterprise) {
    web.route('/api/v1/basic').get(webAuth, (_: Request, res: Response) => {
        res.status(200).send();
    });
}

// Webapp assets, static files and build.
const webappBuildPath = '../../../webapp/build';
web.use('/assets', express.static(path.join(dirname(), webappBuildPath), { immutable: true, maxAge: '1y' }));
web.use(express.static(path.join(dirname(), webappBuildPath), { setHeaders: () => ({ 'Cache-Control': 'no-cache, private' }) }));
web.get('*', (_, res) => {
    res.sendFile(path.join(dirname(), webappBuildPath, 'index.html'), { headers: { 'Cache-Control': 'no-cache, private' } });
});

app.use(web);

// Error handling.
app.use(async (e: any, req: Request, res: Response, __: any) => {
    await errorManager.handleGenericError(e, req, res, tracer);
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: getWebsocketsPath() });

wss.on('connection', async (ws: WebSocket) => {
    await publisher.subscribe(ws);
});

const port = getPort();
server.listen(port, () => {
    logger.info(`✅ Nango Server with version ${packageJsonFile().version} is listening on port ${port}. OAuth callback URL: ${getGlobalOAuthCallbackUrl()}`);
    logger.info(
        `\n   |     |     |     |     |     |     |\n   |     |     |     |     |     |     |\n   |     |     |     |     |     |     |  \n \\ | / \\ | / \\ | / \\ | / \\ | / \\ | / \\ | /\n  \\|/   \\|/   \\|/   \\|/   \\|/   \\|/   \\|/\n------------------------------------------\nLaunch Nango at http://localhost:${port}\n------------------------------------------\n  /|\\   /|\\   /|\\   /|\\   /|\\   /|\\   /|\\\n / | \\ / | \\ / | \\ / | \\ / | \\ / | \\ / | \\\n   |     |     |     |     |     |     |\n   |     |     |     |     |     |     |\n   |     |     |     |     |     |     |`
    );
});
