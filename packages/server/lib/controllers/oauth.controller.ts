import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';
import * as uuid from 'uuid';
import simpleOauth2 from 'simple-oauth2';
import { OAuth1Client } from '../clients/oauth1.client.js';
import {
    getAdditionalAuthorizationParams,
    getConnectionMetadataFromCallbackRequest,
    missesInterpolationParam,
    getConnectionMetadataFromTokenResponse
} from '../utils/utils.js';
import type {
    LogLevel,
    Config as ProviderConfig,
    Template as ProviderTemplate,
    TemplateOAuth2 as ProviderTemplateOAuth2,
    OAuthSession,
    OAuth1RequestTokenResult,
    OAuth2Credentials,
    ConnectionConfig
} from '@nangohq/shared';
import {
    getConnectionConfig,
    connectionCreated as connectionCreatedHook,
    connectionCreationFailed as connectionCreationFailedHook,
    interpolateStringFromObject,
    getOauthCallbackUrl,
    getGlobalAppCallbackUrl,
    createActivityLog,
    createActivityLogMessageAndEnd,
    createActivityLogMessage,
    updateProvider as updateProviderActivityLog,
    updateSuccess as updateSuccessActivityLog,
    findActivityLogBySession,
    updateProviderConfigAndConnectionId as updateProviderConfigAndConnectionIdActivityLog,
    AuthOperation,
    updateSessionId as updateSessionIdActivityLog,
    addEndTime as addEndTimeActivityLog,
    LogActionEnum,
    configService,
    connectionService,
    environmentService,
    AuthModes as ProviderAuthModes,
    oauth2Client,
    getAccount,
    getEnvironmentId,
    providerClientManager,
    errorManager,
    analytics,
    telemetry,
    LogTypes,
    AnalyticsTypes,
    hmacService,
    ErrorSourceEnum
} from '@nangohq/shared';
import publisher from '../clients/publisher.client.js';
import * as WSErrBuilder from '../utils/web-socket-error.js';
import oAuthSessionService from '../services/oauth-session.service.js';
import { errorToObject } from '@nangohq/utils';

class OAuthController {
    public async oauthRequest(req: Request, res: Response, _next: NextFunction) {
        const accountId = getAccount(res);
        const environmentId = getEnvironmentId(res);
        const { providerConfigKey } = req.params;
        let connectionId = req.query['connection_id'] as string | undefined;
        const wsClientId = req.query['ws_client_id'] as string | undefined;
        const userScope = req.query['user_scope'] as string | undefined;

        const log = {
            level: 'info' as LogLevel,
            success: false,
            action: LogActionEnum.AUTH,
            start: Date.now(),
            end: Date.now(),
            timestamp: Date.now(),
            connection_id: connectionId as string,
            provider_config_key: providerConfigKey as string,
            environment_id: environmentId
        };

        const activityLogId = await createActivityLog(log);

        try {
            if (!wsClientId) {
                void analytics.track(AnalyticsTypes.PRE_WS_OAUTH, accountId);
            }

            await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_START, 'OAuth request process start', LogActionEnum.AUTH, {
                environmentId: String(environmentId),
                accountId: String(accountId),
                providerConfigKey: String(providerConfigKey),
                connectionId: String(connectionId)
            });

            const callbackUrl = await getOauthCallbackUrl(environmentId);
            const connectionConfig = req.query['params'] != null ? getConnectionConfig(req.query['params']) : {};
            const authorizationParams = req.query['authorization_params'] != null ? getAdditionalAuthorizationParams(req.query['authorization_params']) : {};
            const overrideCredentials = req.query['credentials'] != null ? getAdditionalAuthorizationParams(req.query['credentials']) : {};

            if (connectionId == null) {
                const error = WSErrBuilder.MissingConnectionId();
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    timestamp: Date.now(),
                    content: error.message
                });

                return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
            } else if (providerConfigKey == null) {
                const error = WSErrBuilder.MissingProviderConfigKey();
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    timestamp: Date.now(),
                    content: error.message
                });

                return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
            }

            connectionId = connectionId.toString();

            const hmacEnabled = await hmacService.isEnabled(environmentId);
            if (hmacEnabled) {
                const hmac = req.query['hmac'] as string | undefined;
                if (!hmac) {
                    const error = WSErrBuilder.MissingHmac();
                    await createActivityLogMessageAndEnd({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId as number,
                        timestamp: Date.now(),
                        content: error.message
                    });

                    return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
                }
                const verified = await hmacService.verify(hmac, environmentId, providerConfigKey, connectionId);

                if (!verified) {
                    const error = WSErrBuilder.InvalidHmac();
                    await createActivityLogMessageAndEnd({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId as number,
                        timestamp: Date.now(),
                        content: error.message
                    });

                    return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
                }
            }

            await createActivityLogMessage({
                level: 'info',
                environment_id: environmentId,
                activity_log_id: activityLogId as number,
                content: 'Authorization URL request from the client',
                timestamp: Date.now(),
                url: callbackUrl,
                params: {
                    ...connectionConfig,
                    hmacEnabled
                }
            });

            const config = await configService.getProviderConfig(providerConfigKey, environmentId);

            await updateProviderActivityLog(activityLogId as number, String(config?.provider));

            if (config == null) {
                const error = WSErrBuilder.UnknownProviderConfigKey(providerConfigKey);
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    content: error.message,
                    timestamp: Date.now(),
                    url: callbackUrl
                });

                return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
            }

            let template: ProviderTemplate;
            try {
                template = configService.getTemplate(config.provider);
            } catch {
                const error = WSErrBuilder.UnknownProviderTemplate(config.provider);
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    content: error.message,
                    timestamp: Date.now(),
                    url: callbackUrl
                });

                return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
            }

            const session: OAuthSession = {
                providerConfigKey: providerConfigKey,
                provider: config.provider,
                connectionId: connectionId,
                callbackUrl: callbackUrl,
                authMode: template.auth_mode,
                codeVerifier: crypto.randomBytes(24).toString('hex'),
                id: uuid.v1(),
                connectionConfig,
                environmentId,
                webSocketClientId: wsClientId
            };

            if (userScope) {
                session.connectionConfig['user_scope'] = userScope;
            }

            await updateSessionIdActivityLog(activityLogId as number, session.id);
            // TODO: handle that

            // certain providers need the credentials to be specified in the config
            if (overrideCredentials) {
                if (overrideCredentials['oauth_client_id_override']) {
                    config.oauth_client_id = overrideCredentials['oauth_client_id_override'];

                    session.connectionConfig = {
                        ...session.connectionConfig,
                        oauth_client_id_override: config.oauth_client_id
                    };
                }
                if (overrideCredentials['oauth_client_secret_override']) {
                    config.oauth_client_secret = overrideCredentials['oauth_client_secret_override'];

                    session.connectionConfig = {
                        ...session.connectionConfig,
                        oauth_client_secret_override: config.oauth_client_secret
                    };
                }
            }

            if (connectionConfig['oauth_scopes_override']) {
                config.oauth_scopes = connectionConfig['oauth_scopes_override'];
            }

            if (
                template.auth_mode !== ProviderAuthModes.App &&
                (config?.oauth_client_id == null || config?.oauth_client_secret == null || config.oauth_scopes == null)
            ) {
                const error = WSErrBuilder.InvalidProviderConfig(providerConfigKey);
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    content: error.message,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: callbackUrl
                });

                return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
            }

            if (template.auth_mode === ProviderAuthModes.OAuth2) {
                return this.oauth2Request({
                    template: template as ProviderTemplateOAuth2,
                    providerConfig: config,
                    session,
                    res,
                    connectionConfig,
                    authorizationParams,
                    callbackUrl,
                    activityLogId: activityLogId as number,
                    environment_id: environmentId,
                    userScope
                });
            } else if (template.auth_mode === ProviderAuthModes.App || template.auth_mode === ProviderAuthModes.Custom) {
                const appCallBackUrl = getGlobalAppCallbackUrl();
                return this.appRequest(template, config, session, res, authorizationParams, appCallBackUrl, activityLogId!, environmentId);
            } else if (template.auth_mode === ProviderAuthModes.OAuth1) {
                return this.oauth1Request(template, config, session, res, callbackUrl, activityLogId!, environmentId);
            }

            const error = WSErrBuilder.UnknownAuthMode(template.auth_mode);
            await createActivityLogMessageAndEnd({
                level: 'error',
                environment_id: environmentId,
                activity_log_id: activityLogId as number,
                content: error.message,
                timestamp: Date.now(),
                url: callbackUrl
            });

            return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, error);
        } catch (e) {
            const prettyError = JSON.stringify(e, ['message', 'name'], 2);
            const error = WSErrBuilder.UnknownError();
            await createActivityLogMessage({
                level: 'error',
                environment_id: environmentId,
                activity_log_id: activityLogId as number,
                content: error.message + '\n' + prettyError,
                timestamp: Date.now()
            });

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                environmentId,
                metadata: {
                    providerConfigKey,
                    connectionId
                }
            });

            return publisher.notifyErr(res, wsClientId, providerConfigKey, connectionId, WSErrBuilder.UnknownError(prettyError));
        }
    }

    public async oauth2RequestCC(req: Request, res: Response, next: NextFunction) {
        const accountId = getAccount(res);
        const environmentId = getEnvironmentId(res);
        const { providerConfigKey } = req.params;
        const connectionId = req.query['connection_id'] as string | undefined;
        const connectionConfig = req.query['params'] != null ? getConnectionConfig(req.query['params']) : {};
        const body = req.body;

        if (!body.client_id) {
            errorManager.errRes(res, 'missing_client_id');

            return;
        }

        if (!body.client_secret) {
            errorManager.errRes(res, 'missing_client_secret');

            return;
        }

        const { client_id, client_secret }: Record<string, string> = body;

        const log = {
            level: 'info' as LogLevel,
            success: false,
            action: LogActionEnum.AUTH,
            start: Date.now(),
            end: Date.now(),
            timestamp: Date.now(),
            connection_id: connectionId as string,
            provider_config_key: providerConfigKey as string,
            environment_id: environmentId
        };

        const activityLogId = await createActivityLog(log);

        try {
            void analytics.track(AnalyticsTypes.PRE_OAUTH2_CC_AUTH, accountId);

            if (!providerConfigKey) {
                errorManager.errRes(res, 'missing_connection');

                return;
            }

            if (!connectionId) {
                errorManager.errRes(res, 'missing_connection_id');

                return;
            }

            const hmacEnabled = await hmacService.isEnabled(environmentId);
            if (hmacEnabled) {
                const hmac = req.query['hmac'] as string | undefined;
                if (!hmac) {
                    await createActivityLogMessageAndEnd({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId as number,
                        timestamp: Date.now(),
                        content: 'Missing HMAC in query params'
                    });

                    errorManager.errRes(res, 'missing_hmac');

                    return;
                }
                const verified = await hmacService.verify(hmac, environmentId, providerConfigKey, connectionId);
                if (!verified) {
                    await createActivityLogMessageAndEnd({
                        level: 'error',
                        environment_id: environmentId,
                        activity_log_id: activityLogId as number,
                        timestamp: Date.now(),
                        content: 'Invalid HMAC'
                    });

                    errorManager.errRes(res, 'invalid_hmac');

                    return;
                }
            }

            const config = await configService.getProviderConfig(providerConfigKey, environmentId);

            if (!config) {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    content: `Error during OAuth2 client credentials: config not found`,
                    timestamp: Date.now()
                });

                errorManager.errRes(res, 'unknown_provider_config');

                return;
            }

            const template = await configService.getTemplate(config?.provider);

            if (template.auth_mode !== ProviderAuthModes.OAuth2CC) {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    timestamp: Date.now(),
                    content: `Provider ${config?.provider} does not support oauth2 client credentials creation`
                });

                errorManager.errRes(res, 'invalid_auth_mode');

                return;
            }

            await updateProviderActivityLog(activityLogId as number, String(config?.provider));

            const { success, error, response: credentials } = await connectionService.getOauthClientCredentials(template, client_id, client_secret);

            if (!success || !credentials) {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id: environmentId,
                    activity_log_id: activityLogId as number,
                    content: `Error during OAuth2 client credentials creation: ${error}`,
                    timestamp: Date.now()
                });

                errorManager.errRes(res, 'oauth2_cc_error');

                return;
            }

            connectionConfig['scopes'] = Array.isArray(credentials.raw['scope']) ? credentials.raw['scope'] : credentials.raw['scope'].split(' ');

            await createActivityLogMessage({
                level: 'info',
                environment_id: environmentId,
                activity_log_id: activityLogId as number,
                content: `OAuth2 client credentials connection creation was successful`,
                timestamp: Date.now()
            });

            await updateSuccessActivityLog(activityLogId as number, true);

            const [updatedConnection] = await connectionService.upsertConnection(
                connectionId,
                providerConfigKey,
                config.provider,
                credentials,
                connectionConfig,
                environmentId,
                accountId
            );

            if (updatedConnection) {
                void connectionCreatedHook(
                    {
                        id: updatedConnection.id,
                        connection_id: connectionId,
                        provider_config_key: providerConfigKey,
                        environment_id: environmentId,
                        auth_mode: ProviderAuthModes.None,
                        operation: updatedConnection.operation
                    },
                    config?.provider,
                    activityLogId
                );
            }

            res.status(200).send({ providerConfigKey: providerConfigKey, connectionId: connectionId });
        } catch (err) {
            const prettyError = JSON.stringify(err, ['message', 'name'], 2);

            await createActivityLogMessage({
                level: 'error',
                environment_id: environmentId,
                activity_log_id: activityLogId as number,
                content: `Error during OAuth2 client credentials create: ${prettyError}`,
                timestamp: Date.now()
            });

            errorManager.report(err, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                environmentId,
                metadata: {
                    providerConfigKey,
                    connectionId
                }
            });

            void connectionCreationFailedHook(
                {
                    id: -1,
                    connection_id: connectionId as string,
                    provider_config_key: providerConfigKey as string,
                    environment_id: environmentId,
                    auth_mode: ProviderAuthModes.OAuth2CC,
                    error: `Error during Unauth create: ${prettyError}`,
                    operation: AuthOperation.UNKNOWN
                },
                'unknown',
                activityLogId
            );

            next(err);
        }
    }

    private async oauth2Request({
        template,
        providerConfig,
        session,
        res,
        connectionConfig,
        authorizationParams,
        callbackUrl,
        activityLogId,
        environment_id,
        userScope
    }: {
        template: ProviderTemplateOAuth2;
        providerConfig: ProviderConfig;
        session: OAuthSession;
        res: Response;
        connectionConfig: Record<string, string>;
        authorizationParams: Record<string, string | undefined>;
        callbackUrl: string;
        activityLogId: number;
        environment_id: number;
        userScope?: string | undefined;
    }) {
        const oauth2Template = template;
        const channel = session.webSocketClientId;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;
        const tokenUrl = typeof template.token_url === 'string' ? template.token_url : (template.token_url[ProviderAuthModes.OAuth2] as string);

        try {
            if (missesInterpolationParam(template.authorization_url, connectionConfig)) {
                const error = WSErrBuilder.InvalidConnectionConfig(template.authorization_url, JSON.stringify(connectionConfig));
                await createActivityLogMessage({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: error.message,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: callbackUrl,
                    params: {
                        ...connectionConfig
                    }
                });

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
            }

            if (missesInterpolationParam(tokenUrl, connectionConfig)) {
                const error = WSErrBuilder.InvalidConnectionConfig(tokenUrl, JSON.stringify(connectionConfig));
                await createActivityLogMessage({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: error.message,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: callbackUrl,
                    params: {
                        ...connectionConfig
                    }
                });

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
            }

            if (
                oauth2Template.token_params == undefined ||
                oauth2Template.token_params.grant_type == undefined ||
                oauth2Template.token_params.grant_type == 'authorization_code'
            ) {
                let allAuthParams: Record<string, string | undefined> = oauth2Template.authorization_params || {};

                // We always implement PKCE, no matter whether the server requires it or not,
                // unless it has been explicitly turned off for this template
                if (!template.disable_pkce) {
                    const h = crypto
                        .createHash('sha256')
                        .update(session.codeVerifier)
                        .digest('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');
                    allAuthParams['code_challenge'] = h;
                    allAuthParams['code_challenge_method'] = 'S256';
                }

                if (providerConfig.provider === 'slack' && userScope) {
                    allAuthParams['user_scope'] = userScope;
                }

                allAuthParams = { ...allAuthParams, ...authorizationParams }; // Auth params submitted in the request take precedence over the ones defined in the template (including if they are undefined).
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                Object.keys(allAuthParams).forEach((key) => (allAuthParams[key] === undefined ? delete allAuthParams[key] : {})); // Remove undefined values.

                await oAuthSessionService.create(session);

                const simpleOAuthClient = new simpleOauth2.AuthorizationCode(
                    oauth2Client.getSimpleOAuth2ClientConfig(providerConfig, template, connectionConfig)
                );

                let authorizationUri = simpleOAuthClient.authorizeURL({
                    redirect_uri: callbackUrl,
                    scope: providerConfig.oauth_scopes ? providerConfig.oauth_scopes.split(',').join(oauth2Template.scope_separator || ' ') : '',
                    state: session.id,
                    ...allAuthParams
                });

                if (template.authorization_url_replacements) {
                    const urlReplacements = template.authorization_url_replacements || {};

                    Object.keys(template.authorization_url_replacements).forEach((key) => {
                        const replacement = urlReplacements[key];
                        if (typeof replacement === 'string') {
                            authorizationUri = authorizationUri.replace(key, replacement);
                        }
                    });
                }

                await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_CALLBACK_RECEIVED, 'OAuth2 callback url received', LogActionEnum.AUTH, {
                    environmentId: String(environment_id),
                    callbackUrl,
                    providerConfigKey: String(providerConfigKey),
                    provider: String(providerConfig.provider),
                    connectionId: String(connectionId),
                    authMode: String(template.auth_mode)
                });

                await createActivityLogMessage({
                    level: 'info',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: `Redirecting to ${authorizationUri} for ${providerConfigKey} (connection ${connectionId})`,
                    timestamp: Date.now(),
                    url: callbackUrl,
                    auth_mode: template.auth_mode,
                    params: {
                        ...allAuthParams,
                        ...connectionConfig,
                        grant_type: oauth2Template.token_params?.grant_type as string,
                        scopes: providerConfig.oauth_scopes ? providerConfig.oauth_scopes.split(',').join(oauth2Template.scope_separator || ' ') : '',
                        external_api_url: authorizationUri
                    }
                });

                // if they exit the flow add an end time to have it on record
                await addEndTimeActivityLog(activityLogId);

                res.redirect(authorizationUri);
            } else {
                const grantType = oauth2Template.token_params.grant_type;
                const error = WSErrBuilder.UnknownGrantType(grantType);

                await createActivityLogMessage({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: error.message,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: callbackUrl,
                    params: {
                        grant_type: grantType,
                        basic_auth_enabled: template.token_request_auth_method === 'basic',
                        ...connectionConfig
                    }
                });

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
            }
        } catch (err: any) {
            const prettyError = JSON.stringify(err, ['message', 'name'], 2);

            const error = WSErrBuilder.UnknownError();
            const content = error.message + '\n' + prettyError;

            await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_FAILURE, `OAuth2 request process failed ${content}`, LogActionEnum.AUTH, {
                callbackUrl,
                environmentId: String(environment_id),
                providerConfigKey: String(providerConfigKey),
                connectionId: String(connectionId)
            });

            await createActivityLogMessage({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content,
                timestamp: Date.now(),
                auth_mode: template.auth_mode,
                url: callbackUrl,
                params: {
                    ...connectionConfig
                }
            });

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, WSErrBuilder.UnknownError(prettyError));
        }
    }

    private async appRequest(
        template: ProviderTemplate,
        providerConfig: ProviderConfig,
        session: OAuthSession,
        res: Response,
        authorizationParams: Record<string, string | undefined>,
        callbackUrl: string,
        activityLogId: number,
        environment_id: number
    ) {
        const channel = session.webSocketClientId;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;

        const connectionConfig = {
            ...authorizationParams,
            appPublicLink: providerConfig.app_link
        };

        session.connectionConfig = connectionConfig as Record<string, string>;

        try {
            if (missesInterpolationParam(template.authorization_url, connectionConfig)) {
                const error = WSErrBuilder.InvalidConnectionConfig(template.authorization_url, JSON.stringify(connectionConfig));
                await createActivityLogMessage({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: error.message,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: callbackUrl,
                    params: {
                        ...connectionConfig
                    }
                });

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
            }

            await oAuthSessionService.create(session);

            const appUrl = interpolateStringFromObject(template.authorization_url, {
                connectionConfig
            });

            const params = new URLSearchParams({
                state: session.id
            });

            const authorizationUri = `${appUrl}?${params.toString()}`;

            await createActivityLogMessage({
                level: 'info',
                environment_id,
                activity_log_id: activityLogId,
                content: `Redirecting to ${authorizationUri} for ${providerConfigKey} (connection ${connectionId})`,
                timestamp: Date.now(),
                url: callbackUrl,
                auth_mode: template.auth_mode,
                params: {
                    ...connectionConfig,
                    external_api_url: authorizationUri
                }
            });

            await addEndTimeActivityLog(activityLogId);

            res.redirect(authorizationUri);
        } catch (error: any) {
            const prettyError = JSON.stringify(error, ['message', 'name'], 2);

            const content = WSErrBuilder.UnknownError().message + '\n' + prettyError;

            await createActivityLogMessage({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content,
                timestamp: Date.now(),
                auth_mode: template.auth_mode,
                url: callbackUrl,
                params: {
                    ...connectionConfig
                }
            });

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, WSErrBuilder.UnknownError(prettyError));
        }
    }

    // In OAuth 2 we are guaranteed that the state parameter will be sent back to us
    // for the entire journey. With OAuth 1.0a we have to register the callback URL
    // in a first step and will get called back there. We need to manually include the state
    // param there, otherwise we won't be able to identify the user in the callback
    private async oauth1Request(
        template: ProviderTemplate,
        config: ProviderConfig,
        session: OAuthSession,
        res: Response,
        callbackUrl: string,
        activityLogId: number,
        environment_id: number
    ) {
        const callbackParams = new URLSearchParams({
            state: session.id
        });
        const channel = session.webSocketClientId;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;

        const oAuth1CallbackURL = `${callbackUrl}?${callbackParams.toString()}`;

        await createActivityLogMessage({
            level: 'info',
            environment_id,
            activity_log_id: activityLogId,
            content: `OAuth callback URL was retrieved`,
            timestamp: Date.now(),
            auth_mode: template.auth_mode,
            url: oAuth1CallbackURL
        });

        const oAuth1Client = new OAuth1Client(config, template, oAuth1CallbackURL);

        let tokenResult: OAuth1RequestTokenResult | undefined;
        try {
            tokenResult = await oAuth1Client.getOAuthRequestToken();
        } catch (err) {
            const error = errorToObject(err);
            errorManager.report(new Error('token_retrieval_error'), {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                environmentId: session.environmentId,
                metadata: error
            });

            const userError = WSErrBuilder.TokenError();
            await createActivityLogMessage({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content: userError.message,
                timestamp: Date.now(),
                auth_mode: template.auth_mode,
                url: oAuth1CallbackURL,
                params: {
                    ...error
                }
            });

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, userError);
        }

        session.requestTokenSecret = tokenResult.request_token_secret;
        await oAuthSessionService.create(session);
        const redirectUrl = oAuth1Client.getAuthorizationURL(tokenResult);

        await createActivityLogMessage({
            level: 'info',
            environment_id,
            activity_log_id: activityLogId,
            content: `Request token for ${session.providerConfigKey} (connection: ${session.connectionId}) was a success. Redirecting to: ${redirectUrl}`,
            timestamp: Date.now(),
            auth_mode: template.auth_mode,
            url: oAuth1CallbackURL
        });

        // if they end the flow early, be sure to have an end time
        await addEndTimeActivityLog(activityLogId);

        await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_CALLBACK_RECEIVED, 'OAuth1 callback url received', LogActionEnum.AUTH, {
            environmentId: String(environment_id),
            callbackUrl,
            providerConfigKey: String(providerConfigKey),
            provider: config.provider,
            connectionId: String(connectionId),
            authMode: String(template.auth_mode)
        });

        // All worked, let's redirect the user to the authorization page
        return res.redirect(redirectUrl);
    }

    public async oauthCallback(req: Request, res: Response, _: NextFunction) {
        const { state } = req.query;

        const installation_id = req.query['installation_id'] as string | undefined;
        const action = req.query['setup_action'] as string;

        if (!state && installation_id && action) {
            res.redirect(req.get('referer') || req.get('Referer') || req.headers.referer || 'https://github.com');

            return;
        }

        if (state == null) {
            const errorMessage = 'No state found in callback';
            const e = new Error(errorMessage);

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                metadata: errorManager.getExpressRequestContext(req)
            });
            return;
        }

        const session = await oAuthSessionService.findById(state as string);

        if (session == null) {
            const errorMessage = `No session found for state: ${state}`;
            const e = new Error(errorMessage);

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                metadata: errorManager.getExpressRequestContext(req)
            });
            return;
        } else {
            await oAuthSessionService.delete(state as string);
        }

        const activityLogId = await findActivityLogBySession(session.id);

        const channel = session.webSocketClientId;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;

        await updateProviderConfigAndConnectionIdActivityLog(activityLogId as number, providerConfigKey, connectionId);

        try {
            await createActivityLogMessage({
                level: 'debug',
                environment_id: session.environmentId,
                activity_log_id: activityLogId as number,
                content: `Received callback from ${session.providerConfigKey} for connection ${session.connectionId}`,
                state: state as string,
                timestamp: Date.now(),
                url: req.originalUrl
            });

            const template = configService.getTemplate(session.provider);
            const config = (await configService.getProviderConfig(session.providerConfigKey, session.environmentId))!;

            if (session.authMode === ProviderAuthModes.OAuth2 || session.authMode === ProviderAuthModes.Custom) {
                return this.oauth2Callback(template as ProviderTemplateOAuth2, config, session, req, res, activityLogId!, session.environmentId);
            } else if (session.authMode === ProviderAuthModes.OAuth1) {
                return this.oauth1Callback(template, config, session, req, res, activityLogId!, session.environmentId);
            }

            const error = WSErrBuilder.UnknownAuthMode(session.authMode);
            await createActivityLogMessage({
                level: 'error',
                environment_id: session.environmentId,
                activity_log_id: activityLogId as number,
                content: error.message,
                state: state as string,
                timestamp: Date.now(),
                auth_mode: session.authMode,
                url: req.originalUrl
            });

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
        } catch (e) {
            const prettyError = JSON.stringify(e, ['message', 'name'], 2);

            errorManager.report(e, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                environmentId: session.environmentId,
                metadata: errorManager.getExpressRequestContext(req)
            });

            const content = WSErrBuilder.UnknownError().message + '\n' + prettyError;

            await createActivityLogMessage({
                level: 'error',
                environment_id: session.environmentId,
                activity_log_id: activityLogId as number,
                content,
                timestamp: Date.now(),
                params: {
                    ...errorManager.getExpressRequestContext(req)
                }
            });

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, WSErrBuilder.UnknownError(prettyError));
        }
    }

    private async oauth2Callback(
        template: ProviderTemplateOAuth2,
        config: ProviderConfig,
        session: OAuthSession,
        req: Request,
        res: Response,
        activityLogId: number,
        environment_id: number
    ) {
        const { code } = req.query;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;
        const channel = session.webSocketClientId;
        const callbackMetadata = getConnectionMetadataFromCallbackRequest(req.query, template);

        const installationId = req.query['installation_id'] as string | undefined;

        if (!code) {
            const error = WSErrBuilder.InvalidCallbackOAuth2();
            await createActivityLogMessage({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content: error.message,
                timestamp: Date.now(),
                params: {
                    scopes: config.oauth_scopes,
                    basic_auth_enabled: template.token_request_auth_method === 'basic',
                    token_params: template?.token_params as string
                }
            });

            await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_FAILURE, 'OAuth2 token request failed with a missing code', LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                providerConfigKey: String(providerConfigKey),
                provider: String(config.provider),
                connectionId: String(connectionId),
                authMode: String(template.auth_mode)
            });

            void connectionCreationFailedHook(
                {
                    id: -1,
                    connection_id: connectionId,
                    provider_config_key: providerConfigKey,
                    environment_id,
                    auth_mode: template.auth_mode,
                    error: error.message,
                    operation: AuthOperation.UNKNOWN
                },
                session.provider,
                activityLogId
            );

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
        }

        // no need to do anything here until the request is approved
        if (session.authMode === ProviderAuthModes.Custom && req.query['setup_action'] === 'update' && installationId) {
            // this means the update request was performed from the provider itself
            if (!req.query['state']) {
                res.redirect(req.get('referer') || req.get('Referer') || req.headers.referer || 'https://github.com');

                return;
            }

            await createActivityLogMessage({
                level: 'info',
                environment_id,
                activity_log_id: activityLogId,
                content: `Update request has been made for ${session.provider} using ${providerConfigKey} for the connection ${connectionId}`,
                timestamp: Date.now()
            });
            await updateSuccessActivityLog(activityLogId, true);

            return publisher.notifySuccess(res, channel, providerConfigKey, connectionId);
        }

        // check for oauth overrides in the connnection config
        if (session.connectionConfig['oauth_client_id_override']) {
            config.oauth_client_id = session.connectionConfig['oauth_client_id_override'];
        }

        if (session.connectionConfig['oauth_client_secret_override']) {
            config.oauth_client_secret = session.connectionConfig['oauth_client_secret_override'];
        }

        if (session.connectionConfig['oauth_scopes']) {
            config.oauth_scopes = session.connectionConfig['oauth_scopes'];
        }

        const simpleOAuthClient = new simpleOauth2.AuthorizationCode(oauth2Client.getSimpleOAuth2ClientConfig(config, template, session.connectionConfig));

        let additionalTokenParams: Record<string, string> = {};
        if (template.token_params !== undefined) {
            // We need to remove grant_type, simpleOAuth2 handles that for us
            const deepCopy = JSON.parse(JSON.stringify(template.token_params));
            additionalTokenParams = deepCopy;
        }

        // We always implement PKCE, no matter whether the server requires it or not,
        // unless it has been explicitly disabled for this provider template
        if (!template.disable_pkce) {
            additionalTokenParams['code_verifier'] = session.codeVerifier;
        }

        const headers: Record<string, string> = {};

        if (template.token_request_auth_method === 'basic') {
            headers['Authorization'] = 'Basic ' + Buffer.from(config.oauth_client_id + ':' + config.oauth_client_secret).toString('base64');
        }

        try {
            let rawCredentials: object;

            await createActivityLogMessage({
                level: 'info',
                environment_id,
                activity_log_id: activityLogId,
                content: `Initiating token request for ${session.provider} using ${providerConfigKey} for the connection ${connectionId}`,
                timestamp: Date.now(),
                params: {
                    ...additionalTokenParams,
                    code: code as string,
                    scopes: config.oauth_scopes,
                    basic_auth_enabled: template.token_request_auth_method === 'basic',
                    token_params: template?.token_params as string
                }
            });

            const tokenUrl = typeof template.token_url === 'string' ? template.token_url : (template.token_url[ProviderAuthModes.OAuth2] as string);

            if (providerClientManager.shouldUseProviderClient(session.provider)) {
                rawCredentials = await providerClientManager.getToken(config, tokenUrl, code as string, session.callbackUrl, session.codeVerifier);
            } else {
                const accessToken = await simpleOAuthClient.getToken(
                    {
                        code: code as string,
                        redirect_uri: session.callbackUrl,
                        ...additionalTokenParams
                    },
                    {
                        headers
                    }
                );
                rawCredentials = accessToken.token;
            }

            await createActivityLogMessage({
                level: 'info',
                environment_id,
                activity_log_id: activityLogId,
                content: `Token response was received for ${session.provider} using ${providerConfigKey} for the connection ${connectionId}`,
                timestamp: Date.now()
            });

            const tokenMetadata = getConnectionMetadataFromTokenResponse(rawCredentials, template);

            let parsedRawCredentials: OAuth2Credentials;

            try {
                parsedRawCredentials = connectionService.parseRawCredentials(rawCredentials, ProviderAuthModes.OAuth2) as OAuth2Credentials;
            } catch {
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: `The OAuth token response from the server could not be parsed - OAuth flow failed. The server returned:\n${JSON.stringify(
                        rawCredentials
                    )}`,
                    timestamp: Date.now()
                });

                await telemetry.log(
                    LogTypes.AUTH_TOKEN_REQUEST_FAILURE,
                    'OAuth2 token request failed, response from the server could not be parsed',
                    LogActionEnum.AUTH,
                    {
                        environmentId: String(environment_id),
                        providerConfigKey: String(providerConfigKey),
                        provider: String(config.provider),
                        connectionId: String(connectionId),
                        authMode: String(template.auth_mode)
                    }
                );

                void connectionCreationFailedHook(
                    {
                        id: -1,
                        connection_id: connectionId,
                        provider_config_key: providerConfigKey,
                        environment_id,
                        auth_mode: template.auth_mode,
                        error: 'OAuth2 token request failed, response from the server could not be parsed',
                        operation: AuthOperation.UNKNOWN
                    },
                    session.provider,
                    activityLogId
                );

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, WSErrBuilder.UnknownError());
            }

            const accountId = (await environmentService.getAccountIdFromEnvironment(session.environmentId)) as number;

            let connectionConfig = { ...session.connectionConfig, ...tokenMetadata, ...callbackMetadata };

            let pending = false;

            if (template.auth_mode === ProviderAuthModes.Custom && !connectionConfig['installation_id'] && !installationId) {
                pending = true;

                const custom = config.custom as Record<string, string>;
                connectionConfig = {
                    ...connectionConfig,
                    app_id: custom['app_id'],
                    pending,
                    pendingLog: activityLogId?.toString()
                };
            }

            if (template.auth_mode === ProviderAuthModes.Custom && installationId) {
                connectionConfig = {
                    ...connectionConfig,
                    installation_id: installationId
                };
            }

            if (connectionConfig['oauth_client_id_override']) {
                parsedRawCredentials = {
                    ...parsedRawCredentials,
                    config_override: {
                        client_id: connectionConfig['oauth_client_id_override']
                    }
                };

                connectionConfig = Object.keys(session.connectionConfig).reduce((acc: Record<string, string>, key: string) => {
                    if (key !== 'oauth_client_id_override') {
                        acc[key] = connectionConfig[key] as string;
                    }
                    return acc;
                }, {});
            }

            if (connectionConfig['oauth_client_secret_override']) {
                parsedRawCredentials = {
                    ...parsedRawCredentials,
                    config_override: {
                        ...parsedRawCredentials.config_override,
                        client_secret: connectionConfig['oauth_client_secret_override']
                    }
                };

                connectionConfig = Object.keys(session.connectionConfig).reduce((acc: Record<string, string>, key: string) => {
                    if (key !== 'oauth_client_secret_override') {
                        acc[key] = connectionConfig[key] as string;
                    }
                    return acc;
                }, {});
            }

            if (connectionConfig['oauth_scopes_override']) {
                connectionConfig['oauth_scopes_override'] = !Array.isArray(connectionConfig['oauth_scopes_override'])
                    ? connectionConfig['oauth_scopes_override'].split(',')
                    : connectionConfig['oauth_scopes_override'];
            }

            const [updatedConnection] = await connectionService.upsertConnection(
                connectionId,
                providerConfigKey,
                session.provider,
                parsedRawCredentials,
                connectionConfig,
                session.environmentId,
                accountId
            );

            await updateProviderActivityLog(activityLogId, session.provider);

            await createActivityLogMessageAndEnd({
                level: 'debug',
                environment_id,
                activity_log_id: activityLogId,
                content: `OAuth connection for ${providerConfigKey} was successful${
                    template.auth_mode === ProviderAuthModes.Custom && !installationId ? ' and request for app approval is pending' : ''
                }`,
                timestamp: Date.now(),
                auth_mode: template.auth_mode,
                params: {
                    ...additionalTokenParams,
                    code: code as string,
                    scopes: config.oauth_scopes,
                    basic_auth_enabled: template.token_request_auth_method === 'basic',
                    token_params: template?.token_params as string
                }
            });

            if (updatedConnection) {
                // don't initiate a sync if custom because this is the first step of the oauth flow
                const initiateSync = template.auth_mode === ProviderAuthModes.Custom ? false : true;
                const runPostConnectionScript = true;
                void connectionCreatedHook(
                    {
                        id: updatedConnection.id,
                        connection_id: connectionId,
                        provider_config_key: providerConfigKey,
                        environment_id,
                        auth_mode: template.auth_mode,
                        operation: updatedConnection.operation
                    },
                    session.provider,
                    activityLogId,
                    { initiateSync, runPostConnectionScript }
                );
            }

            if (template.auth_mode === ProviderAuthModes.Custom && installationId) {
                pending = false;
                await connectionService.getAppCredentialsAndFinishConnection(
                    connectionId,
                    config,
                    template,
                    connectionConfig as ConnectionConfig,
                    activityLogId
                );
            } else {
                await updateSuccessActivityLog(activityLogId, template.auth_mode === ProviderAuthModes.Custom ? null : true);
            }

            await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_SUCCESS, 'OAuth2 token request succeeded', LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                providerConfigKey: String(providerConfigKey),
                provider: String(config.provider),
                connectionId: String(connectionId),
                authMode: String(template.auth_mode)
            });

            return publisher.notifySuccess(res, channel, providerConfigKey, connectionId, pending);
        } catch (err) {
            const prettyError = JSON.stringify(err, ['message', 'name'], 2);
            errorManager.report(err, {
                source: ErrorSourceEnum.PLATFORM,
                operation: LogActionEnum.AUTH,
                environmentId: session.environmentId,
                metadata: {
                    providerConfigKey: session.providerConfigKey,
                    connectionId: session.connectionId
                }
            });

            await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_FAILURE, 'OAuth2 token request failed', LogActionEnum.AUTH, {
                environmentId: String(environment_id),
                providerConfigKey: String(providerConfigKey),
                provider: String(config.provider),
                connectionId: String(connectionId),
                authMode: String(template.auth_mode)
            });

            const error = WSErrBuilder.UnknownError();
            await createActivityLogMessageAndEnd({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content: error.message + '\n' + prettyError,
                timestamp: Date.now()
            });

            void connectionCreationFailedHook(
                {
                    id: -1,
                    connection_id: connectionId,
                    provider_config_key: providerConfigKey,
                    environment_id,
                    auth_mode: template.auth_mode,
                    error: error.message + '\n' + prettyError,
                    operation: AuthOperation.UNKNOWN
                },
                session.provider,
                activityLogId
            );

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
        }
    }

    private async oauth1Callback(
        template: ProviderTemplate,
        config: ProviderConfig,
        session: OAuthSession,
        req: Request,
        res: Response,
        activityLogId: number,
        environment_id: number
    ) {
        const { oauth_token, oauth_verifier } = req.query;
        const providerConfigKey = session.providerConfigKey;
        const connectionId = session.connectionId;
        const channel = session.webSocketClientId;
        const metadata = getConnectionMetadataFromCallbackRequest(req.query, template);

        if (!oauth_token || !oauth_verifier) {
            const error = WSErrBuilder.InvalidCallbackOAuth1();
            await createActivityLogMessageAndEnd({
                level: 'error',
                environment_id,
                activity_log_id: activityLogId,
                content: error.message,
                timestamp: Date.now()
            });

            void connectionCreationFailedHook(
                {
                    id: -1,
                    connection_id: connectionId,
                    provider_config_key: providerConfigKey,
                    environment_id,
                    auth_mode: template.auth_mode,
                    error: error.message,
                    operation: AuthOperation.UNKNOWN
                },
                session.provider,
                activityLogId
            );

            return publisher.notifyErr(res, channel, providerConfigKey, connectionId, error);
        }

        const oauth_token_secret = session.requestTokenSecret!;

        const accountId = (await environmentService.getAccountIdFromEnvironment(session.environmentId)) as number;

        const oAuth1Client = new OAuth1Client(config, template, '');
        oAuth1Client
            .getOAuthAccessToken(oauth_token as string, oauth_token_secret, oauth_verifier as string)
            .then(async (accessTokenResult) => {
                const parsedAccessTokenResult = connectionService.parseRawCredentials(accessTokenResult, ProviderAuthModes.OAuth1);

                const [updatedConnection] = await connectionService.upsertConnection(
                    connectionId,
                    providerConfigKey,
                    session.provider,
                    parsedAccessTokenResult,
                    { ...session.connectionConfig, ...metadata },
                    session.environmentId,
                    accountId
                );

                await updateSuccessActivityLog(activityLogId, true);

                await createActivityLogMessageAndEnd({
                    level: 'info',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: `OAuth connection for ${providerConfigKey} was successful`,
                    timestamp: Date.now(),
                    auth_mode: template.auth_mode,
                    url: session.callbackUrl
                });

                await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_SUCCESS, 'OAuth1 token request succeeded', LogActionEnum.AUTH, {
                    environmentId: String(environment_id),
                    providerConfigKey: String(providerConfigKey),
                    provider: String(config.provider),
                    connectionId: String(connectionId),
                    authMode: String(template.auth_mode)
                });

                if (updatedConnection) {
                    // syncs not support for oauth1
                    const initiateSync = false;
                    const runPostConnectionScript = true;
                    void connectionCreatedHook(
                        {
                            id: updatedConnection.id,
                            connection_id: connectionId,
                            provider_config_key: providerConfigKey,
                            environment_id,
                            auth_mode: template.auth_mode,
                            operation: updatedConnection.operation
                        },
                        session.provider,
                        activityLogId,
                        { initiateSync, runPostConnectionScript }
                    );
                }

                return publisher.notifySuccess(res, channel, providerConfigKey, connectionId);
            })
            .catch(async (err) => {
                errorManager.report(err, {
                    source: ErrorSourceEnum.PLATFORM,
                    operation: LogActionEnum.AUTH,
                    environmentId: session.environmentId,
                    metadata: {
                        ...metadata,
                        providerConfigKey: session.providerConfigKey,
                        connectionId: session.connectionId
                    }
                });
                const prettyError = JSON.stringify(err, ['message', 'name'], 2);

                await telemetry.log(LogTypes.AUTH_TOKEN_REQUEST_FAILURE, 'OAuth1 token request failed', LogActionEnum.AUTH, {
                    environmentId: String(environment_id),
                    providerConfigKey: String(providerConfigKey),
                    provider: String(config.provider),
                    connectionId: String(connectionId),
                    authMode: String(template.auth_mode)
                });

                const error = WSErrBuilder.UnknownError();
                await createActivityLogMessageAndEnd({
                    level: 'error',
                    environment_id,
                    activity_log_id: activityLogId,
                    content: error.message + '\n' + prettyError,
                    timestamp: Date.now()
                });

                void connectionCreationFailedHook(
                    {
                        id: -1,
                        connection_id: connectionId,
                        provider_config_key: providerConfigKey,
                        environment_id,
                        auth_mode: template.auth_mode,
                        error: error.message + '\n' + prettyError,
                        operation: AuthOperation.UNKNOWN
                    },
                    session.provider,
                    activityLogId
                );

                return publisher.notifyErr(res, channel, providerConfigKey, connectionId, WSErrBuilder.UnknownError(prettyError));
            });
    }
}

export default new OAuthController();
