const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const size=bytes=>Number(bytes)>=1048576?`${(Number(bytes)/1048576).toFixed(1)} MB`:`${Math.ceil(Number(bytes||0)/1024)} KB`;
const action=(label,attribute,id,disabled=false,primary=false)=>`<button type="button" class="btn ${primary?'':'ghost'}" ${attribute}="${esc(id)}" ${disabled?'disabled':''}>${label}</button>`;

export function deploymentMarkup(site,date,{total=site.deployments.length,page=1,pageSize=25}={}){
 const published=site.publicationStatus==='published';
 return `<div class="website-deployments">
  <section class="website-live" aria-label="Live website">
   <div><span class="website-caption">Production</span><div class="website-live-address">${esc(site.slug)}.e2local.com</div><p>${published?'Your published website is available at this address.':site.publicationStatus==='unavailable'?'Publication status is unavailable. Refresh to check again.':'Publish a version to bring your website online.'}</p></div>
   <div class="website-live-actions"><span class="website-badge ${published?'is-live':''}">${published?'Live':site.publicationStatus==='unavailable'?'Status unavailable':'Not published'}</span>${published?`<a class="btn ghost" href="https://${esc(site.slug)}.e2local.com/" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`:''}</div>
  </section>
  <form data-upload class="website-upload">
   <div class="website-section-heading"><div><h3>Deploy a new version</h3><p>Upload your files, review the preview, then publish.</p></div></div>
   <div class="website-file-choices"><label><strong>Website folder</strong><span>Select your finished website folder.</span><input data-folder type="file" webkitdirectory multiple/></label><label><strong>ZIP or individual files</strong><span>Select an archive or your website files.</span><input data-files type="file" multiple/></label></div>
   <details class="website-requirements"><summary>File requirements</summary><p>Upload ready-to-host static files with lowercase <code>index.html</code> at the root. Compile source projects first. Up to 500 files, 20 MB per file and 50 MB total.</p></details>
   <div class="website-upload-footer"><button class="btn" type="submit">Upload and preview</button><span data-file-selection>No files selected</span></div><p data-upload-status role="status"></p>
  </form>
  <section class="website-history" aria-label="Deployment history"><div class="website-section-heading"><h3>Deployment history</h3><span>${total} ${total===1?'version':'versions'}</span></div>
  ${site.deployments.map((d,index)=>{
   const version=total-(page-1)*pageSize-index;
   const live=site.liveDeploymentId===d.id;
   const label=live?'Live':({ready:'Ready to publish',staging:'Awaiting build',failed:'Build failed',building:'Building'})[d.status]||'Status unknown';
   return `<article class="website-version"><div class="website-version-info"><div class="website-version-title"><strong>Version ${version}</strong><span class="website-badge ${live?'is-live':d.status==='failed'?'is-failed':''}">${label}</span></div><p><time datetime="${esc(d.created_at)}">${esc(date(d.created_at))}</time><span aria-hidden="true"> · </span>${size(d.source_bytes)}</p>${d.error_message?`<p class="website-build-error">${esc(d.error_message)}</p>`:''}</div>
    <div class="website-version-actions">${d.status==='ready'?`${d.preview_token?`<a class="btn ghost" href="https://p-${esc(d.preview_token)}.e2local.com/" target="_blank" rel="noopener noreferrer" aria-label="Preview version ${version}">Preview ↗</a>`:''}${live?'':action('Publish','data-publish',d.id,false,true)}`:['staging','failed'].includes(d.status)?action(d.status==='failed'?'Retry build':'Build preview','data-build',d.id):''}
    <details class="website-version-more"><summary aria-label="More actions for version ${version}">More</summary><div>${action('View files','data-files-id',d.id)}${action('Delete version','data-delete-version',d.id,live||d.status==='building')}</div></details></div></article>`;
  }).join('')||'<div class="website-empty"><strong>No deployments yet</strong><p>Upload your website files above to create your first preview.</p></div>'}
  </section><div data-file-list aria-live="polite"></div></div>`;
}
