import { passkeyClient } from "@better-auth/passkey/client";
import {
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./permissions";

// Same-origin in dev and prod, so baseURL is inferred from the page.
export const authClient = createAuthClient({
  plugins: [
    organizationClient({ ac, roles }),
    magicLinkClient(),
    passkeyClient(),
  ],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
