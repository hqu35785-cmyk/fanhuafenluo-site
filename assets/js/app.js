const body=document.body;
const statusContainer=document.getElementById('status');
const status=statusContainer.querySelector('span');
const statusRetry=document.getElementById('statusRetry');
const cardTemplate=document.getElementById('archiveCardTemplate');
const cards=[];

const authorSections=Object.create(null);
let activeAuthorId='fanhuafenluo';

const headerAuthorAvatar=document.getElementById('headerAuthorAvatar');
const headerAuthorName=document.getElementById('headerAuthorName');
const headerAuthorEnglish=document.getElementById('headerAuthorEnglish');
const headerArchiveCount=document.getElementById('headerArchiveCount');
const authorFilterButtons=[...document.querySelectorAll('.author-filter')];
const galleryEl=document.querySelector('.gallery');
const authorOrder=['fanhuafenluo','public'];
const archiveGallery=document.getElementById('archiveGallery');
const archiveEmptyState=document.getElementById('archiveEmptyState');
const headerAuthorCycle=document.getElementById('headerAuthorCycle');

const SOURCE_BASE=document.baseURI;
const ARCHIVE_COMMIT='__ARCHIVE_COMMIT__';
const ARCHIVE_REF=/^[0-9a-f]{40}$/i.test(ARCHIVE_COMMIT)
  ? ARCHIVE_COMMIT
  : 'main';
const PNG_CDN_BASE=`https://cdn.jsdelivr.net/gh/hqu35785-cmyk/fanhuafenluo-site@${ARCHIVE_REF}/`;
const PNG_RAW_BASE=`https://raw.githubusercontent.com/hqu35785-cmyk/fanhuafenluo-site/${ARCHIVE_REF}/`;

const SOURCE_URLS={
  catalog:'src/data/catalog.json',
  details:{
    fanhuafenluo:'src/data/details-fanhua.json',
    public:'src/data/details-public.json'
  }
};

const catalogState={
  catalog:null,
  activeWork:null,
  loadToken:0,
  detailPromises:Object.create(null),
  detailsReady:Object.create(null)
};

function sourceUrl(path){
  if(!path) return '';
  try{
    return new URL(path,SOURCE_BASE).href;
  }catch{
    return String(path);
  }
}

function isRecord(value){
  return Boolean(
    value &&
    typeof value==='object' &&
    !Array.isArray(value)
  );
}

function requiredText(value,label){
  const text=String(value || '').trim();
  if(!text) throw new Error(`${label} 不能为空`);
  return text;
}

async function fetchJson(path){
  const response=await fetch(sourceUrl(path),{
    credentials:'same-origin'
  });

  if(!response.ok){
    throw new Error(`${path} 加载失败（${response.status}）`);
  }

  try{
    return await response.json();
  }catch{
    throw new Error(`${path} 不是有效的 JSON`);
  }
}

async function buildCatalog(){
  const payload=await fetchJson(SOURCE_URLS.catalog);
  if(
    !isRecord(payload) ||
    payload.schemaVersion!==1 ||
    !Array.isArray(payload.sections)
  ){
    throw new Error('目录数据格式不受支持');
  }

  const catalog=Object.create(null);

  payload.sections.forEach((section,sectionIndex)=>{
    if(!isRecord(section)){
      throw new Error(`目录分区 ${sectionIndex+1} 格式无效`);
    }

    const authorId=requiredText(
      section.id,
      `目录分区 ${sectionIndex+1} 的 id`
    );
    if(!authorOrder.includes(authorId)){
      throw new Error(`未知的目录分区：${authorId}`);
    }
    if(Object.prototype.hasOwnProperty.call(catalog,authorId)){
      throw new Error(`目录分区重复：${authorId}`);
    }
    if(!Array.isArray(section.works)){
      throw new Error(`${authorId} 的 works 必须是数组`);
    }
    if(
      !Number.isInteger(section.pinnedCount) ||
      section.pinnedCount<0 ||
      section.pinnedCount>section.works.length
    ){
      throw new Error(`${authorId} 的 pinnedCount 无效`);
    }

    const works=section.works.map((work,workIndex)=>{
      if(!isRecord(work)){
        throw new Error(`${authorId} 的第 ${workIndex+1} 个作品格式无效`);
      }
      requiredText(work.name,`${authorId} 的第 ${workIndex+1} 个作品名称`);
      requiredText(
        work.preview || work.image,
        `${authorId} 的第 ${workIndex+1} 个作品图片`
      );
      return {...work,_authorId:authorId};
    });

    catalog[authorId]=works;
    authorSections[authorId]={
      name:requiredText(section.name,`${authorId} 的 name`),
      english:requiredText(section.english,`${authorId} 的 english`),
      avatar:sourceUrl(requiredText(section.avatar,`${authorId} 的 avatar`)),
      pinnedCount:section.pinnedCount,
      count:works.length
    };

    if(!works.length){
      console.warn(`[archive] 作者 ${authorId} 没有读到任何角色卡`);
    }
  });

  const missing=authorOrder.filter(authorId=>!(authorId in catalog));
  if(missing.length){
    throw new Error(`目录缺少分区：${missing.join('、')}`);
  }

  return catalog;
}

async function loadAuthorDetails(authorId){
  if(catalogState.detailPromises[authorId]){
    return catalogState.detailPromises[authorId];
  }

  const path=SOURCE_URLS.details[authorId];
  if(!path) throw new Error(`未找到 ${authorId} 的详情数据源`);

  const promise=(async()=>{
    const details=await fetchJson(path);
    if(!isRecord(details)){
      throw new Error(`${path} 的详情数据格式无效`);
    }
    const works=catalogState.catalog?.[authorId] || [];

    works.forEach(work=>{
      Object.assign(
        work,
        details[work._detailKey || work.image] || {}
      );
    });

    catalogState.detailsReady[authorId]=true;

    return details;
  })();

  catalogState.detailPromises[authorId]=promise;

  try{
    return await promise;
  }catch(error){
    delete catalogState.detailPromises[authorId];
    throw error;
  }
}

function ensureWorkDetails(work){
  return loadAuthorDetails(work?._authorId || activeAuthorId);
}

let authorSwitchLocked=false;
let queuedAuthorId=null;

const DEFAULT_PREVIEW_POSITION='50% 8%';

function previewPositionForWork(work){
  const raw=String(work?.previewPosition || '').trim();

  if(raw){
    const parts=raw.split(/\s+/);
    if(parts.length===2){
      const x=Number.parseFloat(parts[0]);
      const y=Number.parseFloat(parts[1]);
      if(
        parts[0].endsWith('%') &&
        parts[1].endsWith('%') &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x>=0 && x<=100 &&
        y>=0 && y<=100
      ){
        return `${x}% ${y}%`;
      }
    }
  }

  return DEFAULT_PREVIEW_POSITION;
}

function applyPreviewPosition(image,work){
  const position=previewPositionForWork(work);
  image.style.objectPosition=position;
  image.dataset.previewPosition=position;
}

function previewFallbackCandidates(work){
  const relative=String(work?.preview || work?.image || '')
    .replace(/^\.\//,'')
    .replace(/^\//,'');

  return [...new Set([
    PNG_CDN_BASE+relative,
    PNG_RAW_BASE+relative
  ])];
}

function fallbackPreview(image,work,card){
  const candidates=previewFallbackCandidates(work);
  const index=Number(image.dataset.fallbackIndex || 0);

  if(index<candidates.length){
    image.dataset.fallbackIndex=String(index+1);
    image.src=candidates[index];
    return;
  }

  image.onerror=null;
  card?.classList.remove('is-image-loading');
  card?.classList.add('image-error','is-face-missing');
  const sub=card?.querySelector('.state-label-loading .loading-sub');
  if(sub) sub.textContent='CARD FACE UNAVAILABLE';
  revealCard(card);
}

function ensureCardPreview(card){
  const art=card.querySelector('.loaded-art');
  let image=art.querySelector('.loaded-card-image');

  if(!image){
    image=document.createElement('img');
    image.className='loaded-card-image';
    image.decoding='async';
    art.prepend(image);
  }

  return image;
}

function formatCreatedAt(work){
  const raw=String(work?.createdAt || work?.created || '').trim();
  const match=raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if(!match) return '';
  return match[1]+'.'+
    match[2].padStart(2,'0')+'.'+
    match[3].padStart(2,'0');
}

function applyAuthorCardContent(authorId,meta){
  const works=catalogState.catalog?.[authorId] || [];
  growCardPool(works.length);
  const firstScreen=firstScreenCount();

  cards.forEach((card,index)=>{
    const work=works[index];
    const show=Boolean(work);

    card.classList.remove(
      'is-loaded',
      'has-source-image',
      'image-error',
      'is-face-missing',
      'is-loading-now'
    );
    card.hidden=!show;
    card._work=work || null;

    if(!show){
      delete card.dataset.author;
      delete card.dataset.workIndex;
      card.removeAttribute('role');
      card.removeAttribute('aria-label');
      const oldImage=card.querySelector('.loaded-card-image');
      if(oldImage){
        oldImage.onload=null;
        oldImage.onerror=null;
        oldImage.removeAttribute('src');
      }
      card.querySelectorAll(
        '.detail-action,.download-action'
      ).forEach(button=>{
        button.disabled=true;
        button.tabIndex=-1;
      });
      return;
    }

    card.dataset.author=authorId;
    card.dataset.workIndex=String(index);
    card.setAttribute('role','group');
    card.setAttribute(
      'aria-label',
      `${work.name} · ${work.cardLabel || work.tags?.[0] || '角色卡'}`
    );

    const number=String(index+1).padStart(2,'0');
    const name=card.querySelector('.ready-name');
    const metaText=card.querySelector('.ready-meta');
    const label=card.querySelector('.corner-label');
    const cornerIndex=card.querySelector('.corner-index');

    if(name) name.textContent=work.name;
    const created=formatCreatedAt(work);
    const readyLabel=card.querySelector('.state-label-ready');
    if(metaText) metaText.textContent=created;
    readyLabel?.classList.toggle('no-created',!created);
    if(label) label.textContent=`ARCHIVE · ${number}`;
    if(cornerIndex) cornerIndex.textContent=number;

    card.querySelector('.detail-action')?.setAttribute(
      'aria-label',
      `查看 ${work.name} 的档案`
    );
    card.querySelector('.download-action')?.setAttribute(
      'aria-label',
      `保存 ${work.name} 的角色卡 PNG`
    );

    const image=ensureCardPreview(card);

    image.alt=`${work.name}角色卡卡面`;
    applyPreviewPosition(image,work);
    /* The catalog currently provides one preview per work, without srcset variants. */
    image.width=640;
    image.height=935;
    image.loading=index<firstScreen?'eager':'lazy';
    image.fetchPriority=index<Math.min(firstScreen,8)?'high':'low';
    image.dataset.fallbackIndex='0';

    card.classList.add('is-image-loading');

    image.onload=()=>{
      if(card._work!==work) return;
      card.classList.remove('is-image-loading');
      card.classList.add('has-source-image');
      revealCard(card);
    };

    image.onerror=()=>{
      if(card._work!==work) return;
      fallbackPreview(image,work,card);
    };

    image.src=sourceUrl(work.preview || work.image);

    card.querySelectorAll(
      '.detail-action,.download-action'
    ).forEach(button=>{
      button.disabled=true;
      button.tabIndex=-1;
    });

  });

  const isEmpty=works.length===0;
  galleryEl.classList.toggle('is-empty',isEmpty);
  if(archiveEmptyState){
    archiveEmptyState.hidden=!isEmpty;
  }
  archiveGallery?.setAttribute('aria-busy','false');
  cardHeightMeasured=false;
  queueCardMetricsRefresh();
}

function setAuthorControlsDisabled(disabled){
  authorFilterButtons.forEach(button=>{
    button.disabled=disabled;
  });

  headerAuthorCycle.disabled=disabled;
}

function paintAuthorHeader(authorId){
  const meta=authorSections[authorId];

  body.dataset.section=authorId;
  headerAuthorName.textContent=meta.name;
  headerAuthorEnglish.textContent=meta.english;
  headerArchiveCount.textContent=String(meta.count);
  headerAuthorAvatar.src=meta.avatar;
  headerAuthorAvatar.alt=`${meta.name}头像`;
}

async function loadCatalog(){
  const token=++catalogState.loadToken;

  setAuthorControlsDisabled(true);
  statusContainer.classList.remove('is-error');
  statusRetry.hidden=true;
  status.textContent='LOADING SOURCE';
  archiveGallery?.setAttribute('aria-busy','true');
  galleryEl.classList.remove('is-empty');
  if(archiveEmptyState) archiveEmptyState.hidden=true;

  // 目录要先走一次网络请求才回来，在那之前画廊是空的：整屏只有背景色，
  // 卡面模板里的「等待卡面」占位根本还没进 DOM。先按首屏容量铺一批占位卡，
  // 让加载过程有东西可看；真数据到了 growCardPool 只会补足数量，不会重建。
  growCardPool(firstScreenCount());

  try{
    const catalog=await buildCatalog();

    if(token!==catalogState.loadToken) return;

    catalogState.catalog=catalog;
    catalogState.detailPromises=Object.create(null);
    catalogState.detailsReady=Object.create(null);

    authorFilterButtons.forEach(button=>{
      const available=Object.prototype.hasOwnProperty.call(
        catalog,
        button.dataset.author
      );
      button.hidden=!available;
    });

    activeAuthorId=authorOrder.find(id=>catalog[id]) || Object.keys(catalog)[0];
    if(!activeAuthorId) throw new Error('没有可用的作者数据');

    authorFilterButtons.forEach(button=>{
      const active=
        button.dataset.author===activeAuthorId;
      button.classList.toggle('active',active);
      button.setAttribute(
        'aria-pressed',
        String(active)
      );
    });

    paintAuthorHeader(activeAuthorId);

    applyAuthorCardContent(
      activeAuthorId,
      authorSections[activeAuthorId]
    );

    setAuthorControlsDisabled(false);
    updateStatus();
  }catch(error){
    console.error(error);

    if(token!==catalogState.loadToken) return;

    status.textContent='SOURCE ERROR · 点击重试';
    statusContainer.classList.add('is-error');
    statusRetry.hidden=false;
    archiveGallery?.setAttribute('aria-busy','false');
    galleryEl.classList.remove('is-empty');
    if(archiveEmptyState) archiveEmptyState.hidden=true;
    // 占位卡只是加载期间的铺垫。取数据失败就把还没绑上作品的收掉，
    // 否则「SOURCE ERROR」旁边会一直挂着一屏「等待卡面」。
    cards.forEach(card=>{if(!card._work) card.hidden=true;});
  }
}

statusRetry.addEventListener('click',loadCatalog);

headerAuthorCycle.addEventListener('click',()=>{
  if(!catalogState.catalog) return;

  const current=authorOrder.indexOf(activeAuthorId);
  const next=authorOrder[
    (current+1)%authorOrder.length
  ];

  setAuthor(next);
});

function setAuthor(authorId){
  if(!catalogState.catalog?.[authorId]) return;
  const meta=authorSections[authorId];
  if(!meta) return;
  if(authorSwitchLocked){
    if(authorId!==activeAuthorId) queuedAuthorId=authorId;
    return;
  }
  if(authorId===activeAuthorId) return;

  authorSwitchLocked=true;
  const fromIndex=Math.max(0,authorOrder.indexOf(activeAuthorId));
  const toIndex=Math.max(0,authorOrder.indexOf(authorId));
  const dir=toIndex>=fromIndex?1:-1;
  const dirName=dir>0?'next':'prev';

  authorFilterButtons.forEach(btn=>{
    const active=btn.dataset.author===authorId;
    btn.classList.toggle('active',active);
    btn.setAttribute('aria-pressed',String(active));
  });

  siteHeader?.style.setProperty('--author-avatar-out-rot',`${-72*dir}deg`);
  siteHeader?.style.setProperty('--author-avatar-in-rot',`${76*dir}deg`);
  siteHeader?.style.setProperty('--author-avatar-bounce-rot',`${-8*dir}deg`);
  siteHeader?.style.setProperty('--author-name-out-x',`${-18*dir}px`);
  siteHeader?.style.setProperty('--author-name-in-x',`${24*dir}px`);
  siteHeader?.style.setProperty('--author-name-over-x',`${-2*dir}px`);
  siteHeader?.style.setProperty('--author-name-out-skew',`${4*dir}deg`);
  siteHeader?.style.setProperty('--author-name-in-skew',`${-6*dir}deg`);
  siteHeader?.style.setProperty('--author-count-out-y',`${-15*dir}px`);
  siteHeader?.style.setProperty('--author-count-in-y',`${18*dir}px`);
  siteHeader?.style.setProperty('--author-count-over-y',`${-2*dir}px`);
  galleryEl.style.setProperty('--author-card-out-x',`${-28*dir}px`);
  galleryEl.style.setProperty('--author-card-in-x',`${42*dir}px`);
  galleryEl.style.setProperty('--author-card-over-x',`${-3*dir}px`);
  galleryEl.dataset.authorDirection=dirName;

  cards.forEach((card,i)=>{
    /* Offscreen cards are not animated, so do not touch all 70 cards. */
    if(!card.classList.contains('is-motion-visible')) return;
    const lean=i%2===0?1:-1;
    card.style.setProperty('--author-delay',`${Math.min(i,12)*11}ms`);
    card.style.setProperty('--author-card-out-rot',`${1.2*dir*lean}deg`);
    card.style.setProperty('--author-card-in-rot',`${-1.8*dir*lean}deg`);
    card.style.setProperty('--author-card-over-rot',`${.18*lean}deg`);
  });

  siteHeader?.classList.remove('author-switch-in');
  galleryEl.classList.remove('author-switch-in');
  siteHeader?.classList.add('author-switch-out');
  galleryEl.classList.add('author-switch-out');

  const swapDelay=prefersReducedMotion.matches?0:235;
  window.setTimeout(()=>{
    activeAuthorId=authorId;
    body.dataset.section=authorId;
    headerAuthorName.textContent=meta.name;
    headerAuthorEnglish.textContent=meta.english;
    headerArchiveCount.textContent=String(meta.count);
    headerAuthorAvatar.src=meta.avatar;
    headerAuthorAvatar.alt=`${meta.name}头像`;
    applyAuthorCardContent(authorId,meta);

    const visibleLoaded=cards.slice(0,meta.count).filter(c=>c.classList.contains('is-loaded')).length;
    status.textContent=visibleLoaded===meta.count
      ? `READY · ${meta.count}`
      : `已显示 ${visibleLoaded} / ${meta.count}`;

    siteHeader?.classList.remove('author-switch-out');
    galleryEl.classList.remove('author-switch-out');

    /* Start the entrance on a fresh frame instead of forcing synchronous layout
       with galleryEl.offsetWidth. */
    const beginAuthorEntrance=()=>{
      siteHeader?.classList.add('author-switch-in');
      galleryEl.classList.add('author-switch-in');
      pulseStatus();

      const settleDelay=prefersReducedMotion.matches?0:590;
      window.setTimeout(()=>{
        siteHeader?.classList.remove('author-switch-in');
        galleryEl.classList.remove('author-switch-in');
        authorSwitchLocked=false;
        const next=queuedAuthorId;
        queuedAuthorId=null;
        if(next && next!==activeAuthorId) setAuthor(next);
      },settleDelay);
    };
    if(prefersReducedMotion.matches) beginAuthorEntrance();
    else requestAnimationFrame(beginAuthorEntrance);
  },swapDelay);
}

authorFilterButtons.forEach(btn=>{
  btn.addEventListener('click',()=>setAuthor(btn.dataset.author));
});


const archiveModal=document.getElementById('archiveModal');
const archiveModalClose=document.getElementById('archiveModalClose');
const saveSheet=document.getElementById('saveSheet');
const saveSheetClose=document.getElementById('saveSheetClose');
const saveSheetPhoto=document.getElementById('saveSheetPhoto');
const saveSheetNote=document.getElementById('saveSheetNote');
let saveSheetShareFile=null;

let activeCard=null;
let lastArchiveTrigger=null;
let lastSaveTrigger=null;
let toastTimer=null;
const prefersReducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
const siteHeader=document.querySelector('.site-header');

function motionDelay(ms,fn){
  if(prefersReducedMotion.matches){ fn(); return; }
  window.setTimeout(fn,ms);
}

function restartClass(el,className,duration=420){
  if(!el || prefersReducedMotion.matches) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  window.setTimeout(()=>el.classList.remove(className),duration);
}

function pulseStatus(){
  restartClass(status,'is-status-pulse',430);
}

function markAction(el){
  restartClass(el,'is-activating',460);
}

function ensureToast(){
  let toast=document.getElementById('motionToast');
  if(toast) return toast;
  toast=document.createElement('div');
  toast.id='motionToast';
  toast.className='motion-toast';
  toast.setAttribute('role','status');
  toast.setAttribute('aria-live','polite');
  toast.innerHTML=`<span class="motion-toast-mark">✓</span><span class="motion-toast-copy"><b>操作完成</b><small>已完成当前操作</small></span>`;
  document.body.appendChild(toast);
  return toast;
}

function showToast(title,message,mark='✓'){
  const toast=ensureToast();
  toast.querySelector('.motion-toast-mark').textContent=mark;
  toast.querySelector('.motion-toast-copy b').textContent=title;
  toast.querySelector('.motion-toast-copy small').textContent=message;
  toast.classList.remove('is-show');
  void toast.offsetWidth;
  toast.classList.add('is-show');
  window.clearTimeout(toastTimer);
  toastTimer=window.setTimeout(()=>toast.classList.remove('is-show'),2600);
}

function setShellInert(on){
  ['.site-header','.archive-main','footer'].forEach(selector=>{
    const element=document.querySelector(selector);
    if(!element) return;
    if(on) element.setAttribute('inert','');
    else element.removeAttribute('inert');
  });
}

function trapTab(container,event){
  if(event.key!=='Tab') return;
  const focusable=[...container.querySelectorAll(
    'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'
  )].filter(element=>
    !element.disabled &&
    element.offsetParent!==null &&
    !element.hidden
  );
  if(!focusable.length) return;

  const first=focusable[0];
  const last=focusable[focusable.length-1];
  if(event.shiftKey && document.activeElement===first){
    event.preventDefault();
    last.focus();
  }else if(!event.shiftKey && document.activeElement===last){
    event.preventDefault();
    first.focus();
  }
}


function updateStatus(){
  const visibleCards=cards.filter(card=>!card.hidden);
  const loaded=visibleCards.filter(c=>c.classList.contains('is-loaded')).length;
  const next=loaded===visibleCards.length
    ? `READY · ${visibleCards.length}`
    : `已显示 ${loaded} / ${visibleCards.length}`;
  if(status.textContent!==next){
    status.textContent=next;
    pulseStatus();
  }
}

function revealCard(card){
  if(
    !card ||
    !card._work ||
    card.classList.contains('is-loaded') ||
    (
      !card.classList.contains('has-source-image') &&
      !card.classList.contains('is-face-missing')
    )
  ) return;

  card.classList.add('is-loaded');
  card.classList.remove('is-loading-now');

  const label=card.querySelector('.corner-label');
  if(label) label.textContent=
    card._work.cardLabel ||
    card._work.tags?.[0] ||
    card._work.role ||
    '角色卡';

  const enabled=Boolean(card._work);
  card.querySelectorAll('.detail-action,.download-action').forEach(btn=>{
    btn.disabled=!enabled;
    btn.tabIndex=enabled?0:-1;
  });

  updateStatus();
}

const nearObserver=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
    entry.target.classList.toggle('is-near',entry.isIntersecting);
  });
  window.requestAnimationFrame(syncCardIntrinsicHeight);
},{rootMargin:'1200px 0px 1200px',threshold:0});

/* Card visibility and intrinsic-height metrics stay independent of page scrolling. */
let metricsRefreshRaf=0;
let cardHeightMeasured=false;

function currentGalleryColumns(){
  const template=getComputedStyle(galleryEl).gridTemplateColumns;
  const columns=template.split(/\s+/).filter(Boolean).length;
  return columns || 1;
}

// 首屏大致装得下的卡片数：预铺占位卡、以及决定哪些卡面用 eager 加载都按它来。
function firstScreenCount(){
  return Math.max(currentGalleryColumns()*2,6);
}

function syncCardIntrinsicHeight(force=false){
  if(cardHeightMeasured && !force) return;
  const probe=cards.find(card=>!card.hidden && card.classList.contains('is-near'))
    || cards.find(card=>!card.hidden);
  if(!probe) return;
  const height=probe.getBoundingClientRect().height;
  if(height>0){
    galleryEl.style.setProperty('--card-ih',`${Math.round(height)}px`);
    cardHeightMeasured=true;
  }
}

function refreshCardMetrics(){
  metricsRefreshRaf=0;
  syncCardIntrinsicHeight(true);
}

function queueCardMetricsRefresh(){
  if(metricsRefreshRaf) return;
  metricsRefreshRaf=requestAnimationFrame(refreshCardMetrics);
}

const motionVisibilityObserver=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
    const card=entry.target;
    card.classList.toggle('is-motion-visible',entry.isIntersecting);
  });
},{rootMargin:'300px 0px 300px',threshold:0});

function registerCard(card,index){
  card._work=null;
  card.querySelectorAll('.detail-action,.download-action').forEach(button=>{
    button.disabled=true;
    button.tabIndex=-1;
  });

  nearObserver.observe(card);
  motionVisibilityObserver.observe(card);
}

function buildCard(index){
  if(!cardTemplate?.content.firstElementChild){
    throw new Error('角色卡模板不存在');
  }
  const card=cardTemplate.content.firstElementChild.cloneNode(true);
  card.classList.add(`pattern-${(index%4)+1}`,`theme-${index%6}`);
  card.querySelector('.corner-label').textContent=
    `ARCHIVE · ${String(index+1).padStart(2,'0')}`;
  return card;
}

function growCardPool(target){
  if(target<=cards.length) return;
  const start=cards.length;
  const fragment=document.createDocumentFragment();
  const added=[];

  for(let index=start;index<target;index++){
    const card=buildCard(index);
    cards.push(card);
    added.push(card);
    fragment.appendChild(card);
  }

  archiveGallery.appendChild(fragment);
  added.forEach((card,index)=>registerCard(card,start+index));
  cardHeightMeasured=false;
  queueCardMetricsRefresh();
}

refreshCardMetrics();
window.requestAnimationFrame(syncCardIntrinsicHeight);

window.addEventListener('resize',()=>{
  queueCardMetricsRefresh();
},{passive:true});

function cardData(card){
  const work=card?._work || null;
  const index=Number(card?.dataset.workIndex || 0);

  if(!work){
    return {
      work:null,
      name:'角色档案',
      created:'—',
      identity:'角色身份',
      index:String(index+1).padStart(2,'0')
    };
  }

  return {
    work,
    name:work.name,
    created:formatCreatedAt(work) || '—',
    identity:
      work.cardLabel ||
      work.tags?.[0] ||
      '角色卡',
    index:String(index+1).padStart(2,'0')
  };
}

function formatPersonalityAndScenario(work){
  const sections=[];
  if(work?.personality){
    sections.push(`【性格设定】\n${work.personality}`);
  }
  if(work?.setting){
    sections.push(`【场景设定】\n${work.setting}`);
  }
  return sections.join('\n\n') || '该角色卡未提供人物设定。';
}

function detailCopyForWork(work){
  return {
    intro:work.intro || '该角色卡暂未提供简介。',
    opening:work.opening || '该角色卡未提供开场白。',
    setting:formatPersonalityAndScenario(work),
    worldbook:work.worldbook || '该角色卡未附带世界书。',
    preset:work.preset || '该角色卡未附带预设。'
  };
}

const PENDING_COPY={
  intro:'正在读取角色资料…',
  opening:'正在读取角色资料…',
  setting:'正在读取角色资料…',
  worldbook:'正在读取角色资料…',
  preset:'正在读取角色资料…'
};
const FAILED_COPY={
  intro:'角色资料读取失败，请关闭后重新打开重试。',
  opening:'角色资料读取失败。',
  setting:'角色资料读取失败。',
  worldbook:'角色资料读取失败。',
  preset:'角色资料读取失败。'
};

const detailTabMeta={
  intro:{index:'01 · CHARACTER DATA',title:'简介',type:'INTRO'},
  opening:{index:'02 · CHARACTER DATA',title:'开场白',type:'OPENING'},
  setting:{index:'03 · CHARACTER DATA',title:'人物设定',type:'SETTING'},
  worldbook:{index:'04 · CHARACTER DATA',title:'世界书',type:'LOREBOOK'},
  preset:{index:'05 · CHARACTER DATA',title:'预设',type:'PRESET'}
};

let currentDetailTab='intro';
const detailTabOrder=['intro','opening','setting','worldbook','preset'];
const detailOptions=document.querySelector('.detail-options');
const detailReadingPanel=document.querySelector('.detail-reading-panel');

function visibleDetailTabs(){
  return detailTabOrder;
}

function renderDetailTabs(){
  const visible=visibleDetailTabs();

  document.querySelectorAll('[data-detail-tab]').forEach(button=>{
    button.hidden=false;
    button.tabIndex=0;
    button.removeAttribute('aria-hidden');
  });

  detailOptions?.style.setProperty('--detail-count',String(visible.length || 1));
  if(!visible.includes(currentDetailTab)){
    currentDetailTab=visible[0] || 'intro';
  }
}

function centerDetailTab(key,instant=false){
  if(!detailOptions) return;
  const button=detailOptions.querySelector(`[data-detail-tab="${key}"]`);
  if(!button||detailOptions.scrollWidth<=detailOptions.clientWidth) return;
  const target=button.offsetLeft+(button.offsetWidth/2)-(detailOptions.clientWidth/2);
  const max=Math.max(0,detailOptions.scrollWidth-detailOptions.clientWidth);
  detailOptions.scrollTo({
    left:Math.max(0,Math.min(max,target)),
    behavior:instant?'auto':'smooth'
  });
}

function paintDetailContent(key){
  const copy=archiveModal._detailCopy || {};
  const meta=detailTabMeta[key] || detailTabMeta.intro;
  document.getElementById('detailPanelIndex').textContent=meta.index;
  document.getElementById('detailPanelTitle').textContent=meta.title;
  document.getElementById('detailPanelType').textContent=meta.type;
  document.getElementById('detailPanelBody').textContent=copy[key] || '暂无内容。';
}

function setDetailTab(key,options={}){
  if(!detailTabMeta[key]) key='intro';
  const visible=visibleDetailTabs();
  if(!visible.includes(key)) key=visible[0] || 'intro';
  const instant=Boolean(options.instant) || prefersReducedMotion.matches;
  const nextIndex=Math.max(0,visible.indexOf(key));
  const panel=detailReadingPanel;

  if(detailOptions){
    detailOptions.style.setProperty('--detail-index',String(nextIndex));
    detailOptions.style.setProperty('--detail-shift',`calc(${nextIndex*100}% + ${nextIndex*6}px)`);
  }

  document.querySelectorAll('[data-detail-tab]').forEach(btn=>{
    const active=btn.dataset.detailTab===key;
    btn.classList.toggle('is-active',active);
    btn.setAttribute('aria-selected',String(active));
    if(active && !instant) restartClass(btn,'is-tab-hit',430);
  });

  paintDetailContent(key);
  currentDetailTab=key;
  centerDetailTab(key,instant);
  if(panel){
    panel.scrollTop=0;
    panel.dataset.detailMode=key;
    panel.classList.remove('is-reading-scrolled');
    panel.removeAttribute('aria-busy');
  }
}

document.querySelectorAll('[data-detail-tab]').forEach(btn=>{
  btn.addEventListener('click',()=>setDetailTab(btn.dataset.detailTab));
});

if(detailReadingPanel){
  let detailScrollRaf=0;
  detailReadingPanel.addEventListener('scroll',()=>{
    if(detailScrollRaf) return;
    detailScrollRaf=requestAnimationFrame(()=>{
      detailScrollRaf=0;
      detailReadingPanel.classList.toggle('is-reading-scrolled',detailReadingPanel.scrollTop>12);
    });
  },{passive:true});
}

async function openArchive(card){
  const data=cardData(card);
  const work=data.work;

  if(!work) return;

  activeCard=card;
  catalogState.activeWork=work;
  lastArchiveTrigger=document.activeElement;

  const authorId=work._authorId || activeAuthorId;
  const detailsReady=Boolean(catalogState.detailsReady?.[authorId]);
  const detailImage=document.getElementById('detailImage');
  const detailArt=detailImage.closest('.detail-art');

  document.getElementById('detailName').textContent=work.name;
  document.getElementById('detailIdentity').textContent=data.identity;
  document.getElementById('detailIndex').textContent=`ARCHIVE · ${data.index}`;
  document.getElementById('detailAlias').textContent=[
    work.alias,
    work.collectionLabel
  ].filter(Boolean).join(' · ') || 'TAVO CHARACTER CARD';

  renderDetailTabs(work);
  archiveModal._detailCopy=detailsReady
    ? detailCopyForWork(work)
    : PENDING_COPY;
  currentDetailTab='intro';
  setDetailTab('intro',{instant:true});

  detailImage.classList.remove('is-ready');
  detailArt?.classList.remove('has-source');
  detailImage.dataset.fallbackIndex='0';
  detailImage.alt=`${work.name}角色卡卡面`;
  applyPreviewPosition(detailImage,work);

  detailImage.onload=()=>{
    if(catalogState.activeWork!==work) return;
    detailImage.classList.add('is-ready');
    detailArt?.classList.add('has-source');
  };

  detailImage.onerror=()=>{
    if(catalogState.activeWork!==work) return;

    const candidates=previewFallbackCandidates(work);
    const index=Number(detailImage.dataset.fallbackIndex || 0);

    if(index<candidates.length){
      detailImage.dataset.fallbackIndex=String(index+1);
      detailImage.src=candidates[index];
    }else{
      detailImage.onerror=null;
      detailImage.classList.remove('is-ready');
      detailArt?.classList.remove('has-source');
    }
  };

  detailImage.src=sourceUrl(work.preview || work.image);

  /* Scale the dossier from the approximate position of the card that opened it. */
  const sourceRect=card.getBoundingClientRect();
  const originX=Math.max(8,Math.min(92,(sourceRect.left+sourceRect.width/2)/window.innerWidth*100));
  const originY=Math.max(8,Math.min(92,(sourceRect.top+sourceRect.height/2)/window.innerHeight*100));
  document.querySelector('.archive-modal-panel')?.style.setProperty('--archive-origin-x',`${originX}%`);
  document.querySelector('.archive-modal-panel')?.style.setProperty('--archive-origin-y',`${originY}%`);

  archiveModal.classList.add('is-open');
  archiveModal.setAttribute('aria-hidden','false');
  archiveModal.removeAttribute('inert');
  body.classList.add('has-overlay');
  setShellInert(true);
  body.style.overflow='hidden';
  motionDelay(180,()=>archiveModalClose.focus({preventScroll:true}));

  try{
    await ensureWorkDetails(work);

    if(
      catalogState.activeWork!==work ||
      !archiveModal.classList.contains('is-open')
    ){
      return;
    }

    renderDetailTabs(work);
    archiveModal._detailCopy=detailCopyForWork(work);
    setDetailTab(currentDetailTab,{instant:true});
  }catch(error){
    console.error(error);
    if(
      catalogState.activeWork===work &&
      archiveModal.classList.contains('is-open')
    ){
      archiveModal._detailCopy=FAILED_COPY;
      setDetailTab(currentDetailTab,{instant:true});
    }
  }
}

function closeArchive(){
  if(!archiveModal.classList.contains('is-open')) return;
  archiveModal.classList.remove('is-open');
  archiveModal.setAttribute('aria-hidden','true');
  archiveModal.setAttribute('inert','');
  if(!saveSheet.classList.contains('is-open')) setShellInert(false);
  motionDelay(430,()=>{
    if(!saveSheet.classList.contains('is-open')) body.style.overflow='';
    if(!archiveModal.classList.contains('is-open') && !saveSheet.classList.contains('is-open')) body.classList.remove('has-overlay');
    if(lastArchiveTrigger && document.contains(lastArchiveTrigger)) lastArchiveTrigger.focus({preventScroll:true});
  });
}

function safeFilename(name){
  return String(name || 'character-card')
    .replace(/[\\/:*?"<>|]/g,'-')
    .replace(/\s+/g,' ')
    .trim();
}

function originalPngCandidates(path){
  const relative=String(path || '')
    .replace(/^\.\//,'')
    .replace(/^\//,'');

  return [...new Set([
    sourceUrl(relative),
    PNG_CDN_BASE+relative,
    PNG_RAW_BASE+relative
  ])];
}

async function fetchOriginalPng(path){
  let lastError=null;

  for(const url of originalPngCandidates(path)){
    const controller=new AbortController();
    const timeout=window.setTimeout(
      ()=>controller.abort(),
      30000
    );

    try{
      const response=await fetch(url,{
        credentials:'omit',
        mode:'cors',
        cache:'force-cache',
        signal:controller.signal
      });

      if(!response.ok){
        throw new Error(
          `PNG 加载失败（${response.status}）`
        );
      }

      const blob=await response.blob();
      const signature=new Uint8Array(
        await blob.slice(0,8).arrayBuffer()
      );
      const expected=[
        137,80,78,71,13,10,26,10
      ];
      const invalid=
        !blob.size ||
        expected.some(
          (byte,index)=>signature[index]!==byte
        );

      if(invalid){
        throw new Error('返回内容不是有效 PNG');
      }

      return blob;
    }catch(error){
      lastError=error;
    }finally{
      window.clearTimeout(timeout);
    }
  }

  throw lastError ||
    new Error('原始 PNG 暂时不可用');
}

let saveSheetObjectUrl=null;
let saveSheetBuildToken=0;

function openSaveSheet(card=activeCard){
  const work=card?._work;

  if(!work) return;

  activeCard=card;
  catalogState.activeWork=work;
  lastSaveTrigger=document.activeElement;
  const data=cardData(card);
  const token=++saveSheetBuildToken;
  const image=document.getElementById('saveSheetImage');
  const link=document.getElementById('saveSheetLink');

  document.getElementById('savePreviewName').textContent=work.name;
  document.getElementById('savePreviewIdentity').textContent=data.identity;
  link.removeAttribute('href');
  link.download=`${safeFilename(work.name)}-character-card.png`;

  saveSheetShareFile=null;
  saveSheet.classList.add('is-preparing');
  saveSheet.classList.remove('is-ready');
  saveSheetPhoto.disabled=true;
  saveSheetPhoto
    .querySelector('.save-choice-copy b')
    .textContent='正在准备原始 PNG…';
  saveSheetNote.textContent=
    '正在读取原始角色卡 PNG，请稍候。';

  saveSheet.classList.add('is-open');
  saveSheet.setAttribute('aria-hidden','false');
  saveSheet.removeAttribute('inert');
  archiveModal.setAttribute('inert','');
  setShellInert(true);
  body.classList.add('has-overlay');
  body.style.overflow='hidden';
  motionDelay(170,()=>saveSheetClose.focus({preventScroll:true}));

  image.style.opacity='0';
  applyPreviewPosition(image,work);

  fetchOriginalPng(work.image).then(blob=>{
    if(
      token!==saveSheetBuildToken ||
      !saveSheet.classList.contains('is-open')
    ) return;

    const oldUrl=saveSheetObjectUrl;
    const nextUrl=URL.createObjectURL(blob);
    saveSheetObjectUrl=nextUrl;

    image.src=nextUrl;
    image.alt=`${work.name}原始角色卡 PNG`;
    image.style.opacity='';
    link.href=nextUrl;

    if(oldUrl){
      URL.revokeObjectURL(oldUrl);
    }

    const file=new File(
      [blob],
      `${safeFilename(work.name)}-character-card.png`,
      {type:'image/png'}
    );

    saveSheetShareFile=file;
    saveSheet.classList.remove('is-preparing');
    saveSheet.classList.add('is-ready');
    window.setTimeout(
      ()=>saveSheet.classList.remove('is-ready'),
      650
    );

    const canShare=
      typeof navigator.share==='function' &&
      (
        !navigator.canShare ||
        navigator.canShare({files:[file]})
      );

    if(canShare){
      saveSheetPhoto.disabled=false;
      saveSheetPhoto
        .querySelector('.save-choice-copy b')
        .textContent='保存到相册';
      saveSheetNote.textContent=
        `原始 PNG 已准备完成，大小 ${(blob.size/1024/1024).toFixed(1)} MB。`;
    }else{
      saveSheetPhoto.disabled=true;
      saveSheetPhoto
        .querySelector('.save-choice-copy b')
        .textContent='当前浏览器不支持保存到相册';
      saveSheetNote.textContent=
        `原始 PNG 已准备完成，大小 ${(blob.size/1024/1024).toFixed(1)} MB；请使用“以文件形式保存”。`;
    }
  }).catch(error=>{
    console.error(error);

    if(token!==saveSheetBuildToken) return;

    image.style.opacity='';
    saveSheet.classList.remove(
      'is-preparing',
      'is-ready'
    );
    saveSheetPhoto.disabled=true;
    saveSheetPhoto
      .querySelector('.save-choice-copy b')
      .textContent='原始 PNG 准备失败';
    saveSheetNote.textContent=
      error.message ||
      '原始 PNG 暂时无法读取，请稍后重试。';
  });
}

function closeSaveSheet(){
  if(!saveSheet.classList.contains('is-open')) return;
  ++saveSheetBuildToken;
  saveSheetShareFile=null;
  saveSheet.classList.remove('is-open','is-preparing','is-ready');
  saveSheet.setAttribute('aria-hidden','true');
  saveSheet.setAttribute('inert','');
  if(archiveModal.classList.contains('is-open')) archiveModal.removeAttribute('inert');
  else archiveModal.setAttribute('inert','');
  setShellInert(archiveModal.classList.contains('is-open'));
  motionDelay(430,()=>{
    if(!archiveModal.classList.contains('is-open')) body.style.overflow='';
    if(!archiveModal.classList.contains('is-open') && !saveSheet.classList.contains('is-open')) body.classList.remove('has-overlay');
    if(lastSaveTrigger && document.contains(lastSaveTrigger)) lastSaveTrigger.focus({preventScroll:true});
  });
}

archiveGallery.addEventListener('click',e=>{
  const detailButton=e.target.closest('.detail-action');
  if(detailButton && archiveGallery.contains(detailButton)){
    if(!detailButton.disabled) openArchive(detailButton.closest('.archive-card'));
    return;
  }

  const downloadButton=e.target.closest('.download-action');
  if(downloadButton && archiveGallery.contains(downloadButton)){
    e.stopPropagation();
    if(!downloadButton.disabled) openSaveSheet(downloadButton.closest('.archive-card'));
  }
});

archiveModalClose.addEventListener('click',closeArchive);
document.querySelectorAll('[data-close-archive]').forEach(el=>el.addEventListener('click',closeArchive));
saveSheetClose.addEventListener('click',closeSaveSheet);
document.querySelectorAll('[data-close-save]').forEach(el=>el.addEventListener('click',closeSaveSheet));

document.getElementById('detailSaveBtn').addEventListener('click',e=>{ markAction(e.currentTarget); openSaveSheet(activeCard); });


saveSheetPhoto.addEventListener('click',async()=>{
  if(!saveSheetShareFile || saveSheetPhoto.disabled) return;
  try{
    saveSheetPhoto.disabled=true;
    saveSheetPhoto.querySelector('.save-choice-copy b').textContent='正在打开系统菜单…';
    await navigator.share({
      files:[saveSheetShareFile],
      title:'保存 TAVO 角色卡'
    });
    saveSheetNote.textContent='文件已交给系统菜单处理。是否进入相册由所选系统应用决定；用于 TAVO 导入时仍建议保留“PNG 原图”文件。';
    markAction(saveSheetPhoto);
    showToast('已交给系统处理','系统保存流程已完成返回；是否进入相册取决于你选择的系统应用。','✓');
  }catch(err){
    if(err && err.name==='AbortError'){
      saveSheetNote.textContent='已取消系统保存菜单。你也可以直接使用“以文件形式保存”。';
    }else{
      saveSheetNote.textContent='系统保存菜单没有成功打开。请长按上方图片保存，或使用“以文件形式保存”。';
    }
  }finally{
    if(saveSheet.classList.contains('is-open')){
      saveSheetPhoto.disabled=false;
      saveSheetPhoto.querySelector('.save-choice-copy b').textContent='保存到相册';
    }
  }
});


/* Download link: the browser does not expose disk-write completion, so acknowledge the initiated download accurately. */
document.getElementById('saveSheetLink').addEventListener('click',e=>{
  markAction(e.currentTarget);
  showToast('PNG 下载已开始','浏览器已接收原图下载任务。','↓');
});

/* Small tactile acknowledgement for all save-sheet choices. */
document.querySelectorAll('.save-sheet-choice').forEach(el=>{
  el.addEventListener('pointerdown',()=>markAction(el));
});

document.addEventListener('keydown',e=>{
  if(saveSheet.classList.contains('is-open')){
    trapTab(saveSheet,e);
  }else if(archiveModal.classList.contains('is-open')){
    trapTab(archiveModal,e);
  }

  if(e.key!=='Escape') return;
  if(saveSheet.classList.contains('is-open')) closeSaveSheet();
  else if(archiveModal.classList.contains('is-open')) closeArchive();
});

loadCatalog();


function syncPageVisibilityMotion(){
  body.classList.toggle('is-page-hidden',document.hidden);
}
document.addEventListener('visibilitychange',syncPageVisibilityMotion,{passive:true});
syncPageVisibilityMotion();

window.addEventListener('beforeunload',()=>{
  if(saveSheetObjectUrl){
    URL.revokeObjectURL(saveSheetObjectUrl);
  }
});
