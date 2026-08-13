import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  ASSET_TYPES,
  isAssetType,
  registrationBlockers,
  requiresLongDescription,
  type AssetType,
  type MediaAssetSummary,
  type MediaLibraryApi,
  type StoredObject,
  type UsageEntry,
} from './media-library-model.js';

/**
 * The Media library (M3-42, FR-QM-06, ACC-03).
 *
 * **Alt text cannot be skipped.** The register action is unavailable until it
 * is there, rather than failing after the upload — an asset that can exist
 * without a description is one that gets referenced before anybody supplies
 * one, and the person who finds out is a student with a screen reader.
 *
 * **Retirement is refused by the domain, and the surface says why.** It does
 * not disable the button silently: an author who cannot retire an asset and
 * cannot see why concludes the tool is broken, and the reason — "four
 * published items still use this" — is exactly the information they need.
 */

export interface MediaLibraryProps {
  readonly api: MediaLibraryApi;
  readonly principalMayManageMedia: boolean;
}

export function MediaLibrary(props: MediaLibraryProps): JSX.Element {
  const { api, principalMayManageMedia } = props;

  const [assets, setAssets] = useState<readonly MediaAssetSummary[]>([]);
  const [selected, setSelected] = useState<MediaAssetSummary | null>(null);
  const [usage, setUsage] = useState<readonly UsageEntry[]>([]);
  const [retirementRefusal, setRetirementRefusal] = useState<string | null>(null);
  const [retired, setRetired] = useState(false);

  const [assetType, setAssetType] = useState<AssetType>('photograph');
  const [stored, setStored] = useState<StoredObject | null>(null);
  const [altText, setAltText] = useState('');
  const [longDescription, setLongDescription] = useState('');
  const [registeredId, setRegisteredId] = useState<string | null>(null);

  const blockers = registrationBlockers({ assetType, stored, altText, longDescription });

  const refresh = useCallback(async (): Promise<void> => {
    setAssets(await api.list());
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback(
    async (asset: MediaAssetSummary): Promise<void> => {
      setSelected(asset);
      setRetirementRefusal(null);
      setRetired(false);
      setUsage(await api.usage(asset.assetId));
    },
    [api],
  );

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setStored(await api.upload(file));
    },
    [api],
  );

  const register = useCallback(async (): Promise<void> => {
    if (stored === null || blockers.length > 0) return;
    const created = await api.register({
      assetType,
      stored,
      altText,
      longDescription: requiresLongDescription(assetType) ? longDescription : null,
    });
    setRegisteredId(created.assetId);
    await refresh();
  }, [altText, api, assetType, blockers.length, longDescription, refresh, stored]);

  const retire = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    const outcome = await api.retire(selected.assetId);
    if (outcome.ok) {
      setRetired(true);
      setRetirementRefusal(null);
      await refresh();
      return;
    }
    setRetirementRefusal(outcome.message);
  }, [api, refresh, selected]);

  if (!principalMayManageMedia) {
    return (
      <main>
        <h1>Media library</h1>
        <p role="alert">You are not permitted to manage media assets.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Media library</h1>

      <section aria-labelledby="library-heading">
        <h2 id="library-heading">Assets</h2>
        {assets.length === 0 ? (
          <p>No assets yet. Register the first one below.</p>
        ) : (
          <ul aria-label="Media assets">
            {assets.map((asset) => (
              <li key={asset.assetId}>
                <button type="button" onClick={() => void select(asset)}>
                  {`${asset.altText} — ${asset.assetType}, used by ${asset.referencingPublishedCount} published`}
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected === null ? null : (
          <div>
            <h3>{selected.altText}</h3>

            {/* The usage graph, from M3-24's single count across items,
                stimuli and solutions — the question is "is anything published
                using this", not "how many of each". */}
            {usage.length === 0 ? (
              <p>No published content uses this asset.</p>
            ) : (
              <>
                <p>{`Used by ${usage.length} published item(s), stimulus/stimuli or solution(s):`}</p>
                <ul aria-label="Published content using this asset">
                  {usage.map((entry) => (
                    <li key={`${entry.ownerType}:${entry.ownerId}`}>
                      {`${entry.ownerType}: ${entry.label}`}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {selected.referencingPublishedCount > 0 ? (
              <p>
                {`Retirement will be refused: ${selected.referencingPublishedCount} published item(s) still reference this asset.`}
              </p>
            ) : null}

            <button type="button" onClick={() => void retire()}>
              Retire this asset
            </button>
            {retirementRefusal === null ? null : <p role="alert">{retirementRefusal}</p>}
            {retired ? <p role="status">Asset retired.</p> : null}
          </div>
        )}
      </section>

      <section aria-labelledby="register-heading">
        <h2 id="register-heading">Register an asset</h2>

        <label htmlFor="media-file">Image file</label>
        <input
          id="media-file"
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void upload(file);
          }}
        />
        {stored === null ? null : (
          <p>{`Stored as ${stored.storageKey} — ${stored.mimeType}, ${stored.width}×${stored.height}.`}</p>
        )}

        <label htmlFor="media-asset-type">Asset type</label>
        <select
          id="media-asset-type"
          value={assetType}
          onChange={(event) => {
            if (isAssetType(event.target.value)) setAssetType(event.target.value);
          }}
        >
          {ASSET_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <label htmlFor="media-alt-text">Alt text</label>
        <input
          id="media-alt-text"
          value={altText}
          onChange={(event) => setAltText(event.target.value)}
        />

        {requiresLongDescription(assetType) ? (
          <>
            <label htmlFor="media-long-description">Long description</label>
            <textarea
              id="media-long-description"
              value={longDescription}
              onChange={(event) => setLongDescription(event.target.value)}
            />
          </>
        ) : null}

        {blockers.length === 0 ? null : (
          <ul aria-label="What registration still needs">
            {blockers.map((blocker) => (
              <li key={blocker.code}>
                <a href={`#${blocker.fieldId}`}>{blocker.message}</a>
              </li>
            ))}
          </ul>
        )}

        <button type="button" onClick={() => void register()} disabled={blockers.length > 0}>
          Register asset
        </button>
        {registeredId === null ? null : <p role="status">Asset registered.</p>}
      </section>
    </main>
  );
}
