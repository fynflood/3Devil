import { DriveThruView } from "./DriveThruView";
import { MyMiniFactoryView } from "./MyMiniFactoryView";
import type { DriveThru } from "../driveThru";
import type { MyMiniFactory } from "../myMiniFactory";
import type { Store } from "../store";
import type { LibrarySource } from "../types";

interface Props {
  store: Store;
  driveThru: DriveThru;
  mmf: MyMiniFactory;
  onOpenProject: (id: string) => void;
  onImportZip: () => void;
}

const SOURCES: [LibrarySource, string][] = [
  ["drivethru", "DriveThruRPG"],
  ["myminifactory", "MyMiniFactory"],
];

/** Every place models can come from, one at a time. */
export function ModelLibrary({ store, driveThru, mmf, onOpenProject, onImportZip }: Props) {
  const source = store.state!.settings.librarySource ?? "drivethru";
  return (
    <div className="library">
      <header className="library-head">
        <h2>Model Library</h2>
        <div className="filters" role="radiogroup" aria-label="Library source">
          {SOURCES.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={source === id}
              className={`chip${source === id ? " active" : ""}`}
              onClick={() => store.actions.setLibrarySource(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {source === "drivethru" ? (
        <DriveThruView store={store} driveThru={driveThru} onOpenProject={onOpenProject} />
      ) : (
        <MyMiniFactoryView store={store} mmf={mmf} onOpenProject={onOpenProject} onImportZip={onImportZip} />
      )}
    </div>
  );
}
