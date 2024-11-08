import { randomUUID } from "node:crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Handler } from "aws-lambda";

const sqs = new SQSClient();

function createRequest(
  user_id: string,
  channel_type: string,
  channel_body: { message: string; receiver_email?: string; subject?: string }
) {
  // required arguments to begin processing request
  if (!user_id || !channel_type || !channel_body) {
    throw new Error(
      "Missing required arguments: user_id, channel, and a channel body must be provided."
    );
  }

  const notification_id = randomUUID();
  const base_log = {
    notification_id,
    user_id,
    channel: channel_type,
  };
  if (channel_type === "in_app") {
    return {
      ...base_log,
      body: {
        message: channel_body.message,
      },
    };
  } else if (channel_type === "email") {
    return {
      ...base_log,
      body: {
        receiver_email: channel_body.receiver_email,
        subject: channel_body.subject,
        message: channel_body.message,
      },
    };
  }
}

export const handler: Handler = async (event) => {
  let response;
  const responseBody: Object[] = [];

  try {
    const body = JSON.parse(event.body);

    // for each object in channel, parse to prepare for queue
    await Promise.all(
      Object.keys(body.channels).map(async (channel) => {
        const notificationRequest = createRequest(
          body.user_id,
          channel,
          body.channels[channel]
        );

        // push to queue
        const queueParams: {
          QueueUrl: string;
          MessageBody: string;
          MessageGroupId: string;
        } = {
          QueueUrl:
            "https://sqs.us-west-1.amazonaws.com/412381737648/LogQueue.fifo",
          MessageBody: JSON.stringify(notificationRequest),
          MessageGroupId: "default-group",
        };

        try {
          const command = new SendMessageCommand(queueParams);
          const sqsResponse = await sqs.send(command);
          console.log("Success! Message send to queue: ", notificationRequest);
        } catch (error) {
          console.error("Error sending message to queue: ", error);
        }

        // push notification_id to responseBody for each channel
        responseBody.push({
          channel: channel,
          notification_id: notificationRequest?.notification_id,
        });
      })
    );

    response = {
      statusCode: 200,
      body: JSON.stringify(responseBody),
    };
  } catch (error) {
    response = {
      statusCode: 500,
      body: "could not process request",
    };
    console.error("error", error);
  }

  return response;
};
