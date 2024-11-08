import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import { NotificationLogDb } from "../constructs/NotificationLogDb";
import { UserAttributesDb } from "../constructs/UserAttributesDb";
import { UserPreferencesDdb } from "../constructs/UserPreferencesDdb";
import { randomUUID } from "node:crypto";

interface CommonStackProps extends StackProps {
  stageName: string;
}

export class CommonStack extends Stack {
  // need to share logging lambda and user attributes
  public readonly notificationLogsDB: NotificationLogDb;
  public readonly userPreferencesDdb: UserPreferencesDdb;
  public readonly userAttributesDB: UserAttributesDb;
  public readonly DYNAMO_LOGGER_FN: string;
  public readonly SAVE_NOTIFICATION_FN: string;

  constructor(scope: Construct, id: string, props: CommonStackProps) {
    super(scope, id, props);

    const stageName = props.stageName || "defaultStage";

    const SAVE_NOTIFICATION_FN = `${stageName}-WebSocketGWStac-saveActiveNotification-${randomUUID().slice(
      0,
      6
    )}`;
    this.SAVE_NOTIFICATION_FN = SAVE_NOTIFICATION_FN;

    const DYNAMO_LOGGER_FN = `${stageName}-DynamoLoggingSt-dynamoLogger-${randomUUID().slice(
      0,
      6
    )}`;
    this.DYNAMO_LOGGER_FN = DYNAMO_LOGGER_FN;

    // create dynamo db table to hold notification logs
    const notificationLogsDB = new NotificationLogDb(
      this,
      `NotificationLogsTable-${stageName}`,
      {
        stageName,
      }
    );
    this.notificationLogsDB = notificationLogsDB;

    // create dynamo db table to hold notification logs
    const userPreferencesDdb = new UserPreferencesDdb(
      this,
      `UserPreferencesTable-${stageName}`,
      {
        stageName,
      }
    );
    this.userPreferencesDdb = userPreferencesDdb;

    // create user attributes table
    const userAttributesDB = new UserAttributesDb(
      this,
      `UserAttributesTable-${stageName}`,
      {
        stageName,
      }
    );
    this.userAttributesDB = userAttributesDB;
  }
}
