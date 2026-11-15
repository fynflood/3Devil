import { nextPrinter } from "../printers";
import type { Store } from "../store";
import type { Job, Project } from "../types";

/** Picks the printer a sliced job is waiting for. */
export function NextOn({ store, project, job }: { store: Store; project: Project; job: Job }) {
  const printers = store.state!.settings.printers ?? [];
  const on = printers.filter((p) => !p.disabled);
  if (!on.length) return null;
  return (
    <label className="inline small next-on" title="The printer this plate is sliced for. It shows there as up next.">
      Next on
      <select
        value={nextPrinter(job, printers)?.id ?? ""}
        onChange={(e) =>
          store.actions.updateJob(project.id, job.id, (j) => {
            if (e.target.value) j.nextOn = e.target.value;
            else delete j.nextOn;
          })
        }
      >
        <option value="">Not picked</option>
        {on.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );
}
