import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { PillButton } from "@/components/ui/Button";
import { findGuestByToken } from "@/lib/data/guests";
import type { Guest } from "@/lib/data/types";
import { describeError } from "@/lib/log-error";

// Cache-Control: private, no-store and X-Robots-Tag are set for this path in next.config.ts.
export const metadata: Metadata = {
  title: "Your link",
  robots: { index: false, follow: false },
};

/**
 * Asked when a browser without a guest opens a personal link (GET /my/[token] sends it here), so a
 * link shared in a group chat doesn't make everyone who taps it that guest. Both answers post to
 * /my/[token], which only accepts them from this site.
 */
export default function ConfirmLinkPage({ params }: PageProps<"/my/[token]/confirm">) {
  return (
    <main className="flex min-h-dvh flex-col bg-blush">
      <Suspense fallback={<ConfirmSkeleton />}>
        <ConfirmLink params={params} />
      </Suspense>
    </main>
  );
}

/** Read at request time: whose link this is. */
async function ConfirmLink({ params }: Pick<PageProps<"/my/[token]/confirm">, "params">) {
  await connection();
  const { token } = await params;
  let guest: Guest | null;
  try {
    guest = await findGuestByToken(token);
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the token.
    console.error("[my] could not look up a personal link:", describeError(error));
    return (
      <Header>
        <p className="m-0 mt-5 text-[15px] leading-[1.65] font-light text-mist">
          Your link didn&apos;t open. Please try again in a moment.
        </p>
      </Header>
    );
  }
  if (!guest) redirect("/album");

  const action = `/my/${guest.linkToken}`;
  return (
    <>
      <Header>
        <div className="mt-5 flex flex-col gap-2.5">
          <h1 className="m-0 font-script text-[46px] leading-[1.12] font-normal [overflow-wrap:anywhere] sm:text-[56px]">
            {guest.displayName ? `Is this you, ${guest.displayName}?` : "Is this your link?"}
          </h1>
          <p className="m-0 text-[15px] leading-[1.65] font-light text-mist">
            This link keeps one guest&apos;s photos and videos together on any phone.
          </p>
        </div>
      </Header>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3.5 px-5 py-8 sm:px-8">
        <form method="post" action={action}>
          <input type="hidden" name="choice" value="yes" />
          <PillButton type="submit" variant="emberLight" block>
            Yes, that&apos;s me
          </PillButton>
        </form>
        <form method="post" action={action}>
          <input type="hidden" name="choice" value="no" />
          <PillButton type="submit" variant="white" block>
            No, I&apos;m someone else
          </PillButton>
        </form>
      </div>
    </>
  );
}

function Header({ children }: { children: ReactNode }) {
  return (
    <PhoneHeader backHref="/album" backText="Album">
      {children}
    </PhoneHeader>
  );
}

function ConfirmSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading your link">
      <Header>
        <div className="mt-5 flex flex-col gap-3">
          <div className="h-12 w-4/5 animate-pulse rounded-full bg-white/10" />
          <div className="h-4 w-full animate-pulse rounded-full bg-white/10" />
        </div>
      </Header>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3.5 px-5 py-8 sm:px-8">
        <div className="h-12 animate-pulse rounded-full bg-tray" />
        <div className="h-12 animate-pulse rounded-full bg-tray" />
      </div>
    </div>
  );
}
