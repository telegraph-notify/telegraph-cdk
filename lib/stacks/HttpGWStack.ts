import { Construct } from "constructs";
import {
  aws_apigatewayv2,
  aws_apigatewayv2_integrations,
  CfnOutput,
  Stack,
  StackProps,
  aws_logs,
  RemovalPolicy,
  aws_iam,
  aws_lambda_nodejs,
  aws_lambda,
  Duration,
  aws_apigatewayv2_authorizers,
} from "aws-cdk-lib";

import * as path from "path";
import { CommonStack } from "./CommonStack";
import * as dotenv from "dotenv";
dotenv.config();

interface HttpGWStackProps extends StackProps {
  stageName: string;
  commonStack: CommonStack;
}

export class HttpGWStack extends Stack {
  constructor(
    scope: Construct,
    id: string,

    props: HttpGWStackProps
  ) {
    super(scope, id, props);

    const stageName = props.stageName || "defaultStage";
    const commonStack = props.commonStack;

    // create getDLQ lambda
    const getDLQ = new aws_lambda_nodejs.NodejsFunction(
      this,
      `getDLQ-${stageName}`,
      {
        runtime: aws_lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: path.join(__dirname, "../../lambdas/httpGW/getDLQ.ts"),
        environment: {
          DLQ_URL: commonStack.dlq.queueUrl,
        },
      }
    );
    commonStack.dlq.grantConsumeMessages(getDLQ);

    // create userFunctions lambda
    const userFunctions = new aws_lambda_nodejs.NodejsFunction(
      this,
      `userFunctions-${stageName}`,
      {
        runtime: aws_lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: path.join(
          __dirname,
          "../../lambdas/userAttributes/userFunctions.ts"
        ),
        environment: {
          USERDB: commonStack.userAttributesDB.UserAttributesTable.tableName,
          USERPREFS:
            commonStack.userPreferencesDdb.UserPreferencesDdb.tableName,
        },
      }
    );

    // create fetchNotifLogsFunctions lambda
    const fetchNotifLogsFunctions = new aws_lambda_nodejs.NodejsFunction(
      this,
      `fetchNotifLogsFunctions-${stageName}`,
      {
        runtime: aws_lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: path.join(
          __dirname,
          "../../lambdas/notificationLogs/fetchNotifLogsFunctions.ts"
        ),
        environment: {
          NOTIFICATION_LOG_TABLE:
            commonStack.notificationLogsDB.NotificationLogTable.tableName,
        },
      }
    );

    // create authorizer lambda
    const httpAuthorizer = new aws_lambda_nodejs.NodejsFunction(
      this,
      `httpAuthorizer-${stageName}`,
      {
        runtime: aws_lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: path.join(__dirname, "../../lambdas/httpGW/httpAuthorizer.ts"),
        environment: {
          SECRET_KEY: process.env.SECRET_KEY!,
        },
        timeout: Duration.seconds(29),
        memorySize: 256,
      }
    );

    // create http authorizer
    const lambdaAuthorizer =
      new aws_apigatewayv2_authorizers.HttpLambdaAuthorizer(
        "LambdaAuthorizer",
        httpAuthorizer,
        {
          identitySource: ["$request.header.Authorization"],
          responseTypes: [
            aws_apigatewayv2_authorizers.HttpLambdaResponseType.SIMPLE,
          ],
          resultsCacheTtl: Duration.seconds(0),
        }
      );

    // give userFunctions permission to access userAttributes and userPreferences
    commonStack.userAttributesDB.UserAttributesTable.grantReadWriteData(
      userFunctions
    );

    commonStack.userPreferencesDdb.UserPreferencesDdb.grantReadWriteData(
      userFunctions
    );

    // give fetchNotifLogsFunctions permission to access notificationLogs
    commonStack.notificationLogsDB.NotificationLogTable.grantReadData(
      fetchNotifLogsFunctions
    );

    // create http api gateway
    const httpApi = new aws_apigatewayv2.HttpApi(this, `HttpApi-${stageName}`, {
      apiName: `HttpApi-${stageName}`,
      corsPreflight: {
        allowHeaders: ["Authorization"],
        allowMethods: [aws_apigatewayv2.CorsHttpMethod.ANY],
        allowOrigins: ["*"],
        maxAge: Duration.days(10),
      },
    });

    // creating log group for access logs
    const logGroup = new aws_logs.LogGroup(this, "HTTPGatewayAccessLogs", {
      logGroupName: `HTTPGatewayAccessLogs-${stageName}`,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: aws_logs.RetentionDays.ONE_MONTH,
    });

    // create a role for API Gateway
    const apiGatewayRole = new aws_iam.Role(this, "ApiGatewayLoggingRole", {
      assumedBy: new aws_iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    // Grant API Gateway permissions to write to Cloudwatch logs
    logGroup.grantWrite(apiGatewayRole);

    // set stage
    const stage = new aws_apigatewayv2.CfnStage(this, `${stageName}`, {
      apiId: httpApi.httpApiId,
      stageName: stageName,
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: logGroup.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          userAgent: "$context.identity.userAgent",
          sourceIp: "$context.identity.sourceIp",
          requestTime: "$context.requestTime",
          httpMethod: "$context.httpMethod",
          path: "$context.path",
          status: "$context.status",
          responseLength: "$context.responseLength",
        }),
      },
    });

    httpApi.addRoutes({
      path: "/notification",
      methods: [aws_apigatewayv2.HttpMethod.POST],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "ProcessIncomingNotificationRequest",
        commonStack.processRequest,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    httpApi.addRoutes({
      path: "/notifications",
      methods: [aws_apigatewayv2.HttpMethod.GET],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "FetchNotificationLogs",
        fetchNotifLogsFunctions,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    httpApi.addRoutes({
      path: "/user",
      methods: [aws_apigatewayv2.HttpMethod.ANY],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "UserFunctions",
        userFunctions,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    httpApi.addRoutes({
      path: "/user/{userId}",
      methods: [aws_apigatewayv2.HttpMethod.GET],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "UserFunctions",
        userFunctions,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    httpApi.addRoutes({
      path: "/users",
      methods: [aws_apigatewayv2.HttpMethod.GET],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "UserFunctions",
        userFunctions,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    httpApi.addRoutes({
      path: "/dlq",
      methods: [aws_apigatewayv2.HttpMethod.GET],
      integration: new aws_apigatewayv2_integrations.HttpLambdaIntegration(
        "GetDLQ",
        getDLQ,
        {
          payloadFormatVersion:
            aws_apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: lambdaAuthorizer,
    });

    // output endpoint
    new CfnOutput(this, `HttpApiInvokeUrl-${stageName}`, {
      value: `https://${httpApi.apiId}.execute-api.${this.region}.amazonaws.com/${stageName}`,
      description: "invoke url for the http api dev stage",
      exportName: `HttpApiInvokeUrl-${stageName}`,
    });
  }
}
