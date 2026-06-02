import type { Request, Response } from "express";
import { SubscribeModel, toSubscribeJson } from "../models/subscribe.model";
import { sendLegacyError } from "../middleware/gateway.middleware";

type SubscribeBody = {
  gmail?: string;
};

export async function createSubscribe(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as SubscribeBody;

  if (!body.gmail) {
    sendLegacyError(res, 400, "gmail is required");
    return;
  }

  const subscribe = await SubscribeModel.create({ gmail: body.gmail });
  res.json({ status: true, subscribe: toSubscribeJson(subscribe) });
}
