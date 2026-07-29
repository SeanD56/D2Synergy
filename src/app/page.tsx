import Link from "next/link";

import {
  GUARDIAN_CLASSES,
  parseClassType,
  parseElement,
  recommend,
  SUBCLASS_ELEMENTS,
} from "@/lib/ui/recommend";

/**
 * The build recommender.
 *
 * A SERVER COMPONENT with no client JavaScript: the solver reads `data/*.json` from disk and runs in
 * ~200ms, so it renders on the server and the pickers are plain links that change the query string.
 * That keeps this first slice honest — no loading states, no hydration, and no duplicated solver
 * logic on the client — and interactivity can be layered in later without moving the solver.
 *
 * `searchParams` is a Promise in Next 16 and must be awaited.
 */

function Picker({
  label,
  options,
  active,
  paramName,
  other,
}: {
  label: string;
  options: readonly string[];
  active: string | undefined;
  paramName: string;
  other: Record<string, string | undefined>;
}) {
  const href = (value: string | undefined) => {
    const params = new URLSearchParams();
    for (const [key, entry] of Object.entries(other)) if (entry) params.set(key, entry);
    if (value) params.set(paramName, value);
    const query = params.toString();
    return query ? `/?${query}` : "/";
  };

  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-gray-400">{label}</span>
      {options.map((option) => (
        <Link
          key={option}
          href={href(option)}
          className={
            option === active
              ? "rounded bg-gray-900 px-2 py-1 text-xs text-white"
              : "rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200"
          }
        >
          {option}
        </Link>
      ))}
      {active !== undefined && (
        <Link href={href(undefined)} className="px-2 py-1 text-xs text-gray-400 underline">
          clear
        </Link>
      )}
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const element = parseElement(params.element);
  const classType = parseClassType(params.class);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">D2Synergy</h1>
        <p className="text-sm text-gray-500">
          Pin what you care about; the solver completes the rest and ranks by synergy.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        <Picker
          label="Element"
          options={SUBCLASS_ELEMENTS}
          active={element}
          paramName="element"
          other={{ class: classType }}
        />
        <Picker
          label="Class"
          options={GUARDIAN_CLASSES}
          active={classType}
          paramName="class"
          other={{ element }}
        />
        <p className="text-xs text-gray-400">
          Pinning a class opens two more dimensions — the solver then chooses your exotic armour and
          both aspects.
        </p>
      </section>

      {element === undefined ? (
        <p className="text-sm text-gray-500">Pick an element to solve.</p>
      ) : (
        <Result element={element} classType={classType} />
      )}
    </main>
  );
}

async function Result({
  element,
  classType,
}: {
  element: NonNullable<ReturnType<typeof parseElement>>;
  classType: ReturnType<typeof parseClassType>;
}) {
  const { result, displays, artifactName, elapsedMs } = await recommend({ element, classType });

  if (!result.feasible) {
    // The solver explains itself (slice 4), so surface its own reasons verbatim rather than
    // inventing a generic failure message that would hide which constraint actually failed.
    return (
      <section className="flex flex-col gap-2 rounded border border-red-200 bg-red-50 p-4">
        <h2 className="text-sm font-semibold text-red-900">No build found</h2>
        <ul className="flex flex-col gap-2">
          {result.reasons.map((reason) => (
            <li key={reason.code} className="text-sm text-red-800">
              <code className="text-xs">{reason.code}</code>
              <br />
              {reason.message}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const top = result.builds[0];
  // Every summary value comes from `display`, never from `top.build`'s hash arrays — that is what
  // keeps "no raw hash on screen" a property of one resolved object rather than of each row.
  const display = displays[0];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Top build — score {top.score.toFixed(2)}</h2>
        <span className="text-xs text-gray-400">
          {result.builds.length} ranked · artifact {artifactName ?? "unresolved"} · solved in{" "}
          {elapsedMs}ms
        </span>
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 rounded border border-gray-200 p-4 text-sm">
        <dt className="text-xs uppercase tracking-wide text-gray-400">Aspects</dt>
        <dd>{display.aspectNames.join(" · ") || "— pin a class"}</dd>
        <dt className="text-xs uppercase tracking-wide text-gray-400">Fragments</dt>
        <dd>{display.fragmentNames.join(" · ") || "—"}</dd>
        <dt className="text-xs uppercase tracking-wide text-gray-400">Exotic armour</dt>
        <dd>{display.exoticName ?? "— pin a class"}</dd>
        <dt className="text-xs uppercase tracking-wide text-gray-400">Artifact perks</dt>
        <dd>{display.artifactPerkNames.join(" · ") || "—"}</dd>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-gray-400">
          Why — {top.synergy.synergies.length} synergies
        </h3>
        <ul className="flex flex-col gap-2">
          {top.synergy.synergies.slice(0, 12).map((synergy) => (
            <li
              key={`${synergy.fromHash}-${synergy.toHash}-${synergy.via}`}
              className="rounded border border-gray-200 p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{synergy.via}</span>
                <span className="text-xs text-gray-400">+{synergy.weight.toFixed(2)}</span>
              </div>
              <p className="mt-1 text-xs text-gray-600">{synergy.why}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
