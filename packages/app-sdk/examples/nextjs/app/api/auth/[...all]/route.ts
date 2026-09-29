import { toNextJsHandler } from "@app/auth-sdk/next-js";
import { auth } from "../../../../lib/auth";

export const runtime = "nodejs";
export const { GET, POST } = toNextJsHandler(auth);
