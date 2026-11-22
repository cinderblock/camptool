import { Text } from "@mantine/core";

/**
 * What a locked-out visitor sees in place of an email-delivered recovery
 * button on deployments with no mail transport (`mailEnabled` in
 * `auth.server.ts`).
 *
 * A "reset my password" button that silently mails nothing is worse than no
 * button: the person waits for a message that never comes and assumes the site
 * is broken rather than asking a human. The real recovery path here is an
 * officer-issued link, delivered out-of-band on purpose
 * (`plans/password-recovery.md`), so say that plainly and inline — no hover,
 * no dead end.
 */
export function NoMailRecoveryNote({
  allowPasswordLogin = false,
}: {
  allowPasswordLogin?: boolean;
}) {
  return (
    <Text size="sm" c="dimmed" ta="center">
      {allowPasswordLogin
        ? "Forgot your password or lost your passkey? "
        : "Lost your passkey or on a new device? "}
      This site doesn&rsquo;t send email, so ask an officer of your camp for a
      recovery link — that&rsquo;s how you get back in.
    </Text>
  );
}
