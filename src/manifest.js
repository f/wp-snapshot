export function transformManifest(source, { reference, warn = () => {} }) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    warn(`Could not parse a web manifest: ${error.message}`);
    return source;
  }

  if (typeof manifest.start_url === 'string') {
    manifest.start_url = reference(manifest.start_url, 'page');
  }

  for (const collectionName of ['icons', 'screenshots']) {
    for (const item of manifest[collectionName] ?? []) {
      if (item && typeof item.src === 'string') item.src = reference(item.src, 'asset');
    }
  }

  for (const shortcut of manifest.shortcuts ?? []) {
    if (typeof shortcut.url === 'string') shortcut.url = reference(shortcut.url, 'page');
    for (const icon of shortcut.icons ?? []) {
      if (icon && typeof icon.src === 'string') icon.src = reference(icon.src, 'asset');
    }
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}
