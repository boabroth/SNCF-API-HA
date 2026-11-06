/* SNCF Train Card — modernisation graphique, compatible avec SNCF-API-HA.
 * Carte autonome, sans dépendance, utilisant les capteurs et device_id existants.
 */
globalThis.customCards ||= [];
if (!globalThis.customCards.some(c => c.type === 'sncf-train-card')) {
  globalThis.customCards.push({type:'sncf-train-card',name:'SNCF Train Card',description:'Horaires SNCF avec rails modernisés',preview:true,configurable:true});
}
class SncfTrainCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'});
    this._timer=null;
    this._registry=null;
    this._registryPromise=null;
    this._renderId=0;
    this._activeDirection=0;
    this._expanded={};
    this._signature='';
    this._painted=false;
    this._platformHistory={};
    this._platformChanges={};
    this._collapsed=false;
  }
  setConfig(config) {
    if (!config.device_id || (Array.isArray(config.device_id) && !config.device_id.length)) throw Error('device_id obligatoire');
    const ids=(Array.isArray(config.device_id)?config.device_id:[config.device_id]).filter(Boolean);
    this.config={
      title:'Trains SNCF',train_lines:100,visible_trains:3,scroll_trains:undefined,direction_titles:'',animation_duration:30,update_interval:30,
      train_emoji:'mdi:train',train_emoji_axial_symmetry:false,
      show_track:true,show_duration:true,show_status:true,show_countdown:true,
      show_platform:true,show_arrival_platform:true,show_train_units:true,show_train_type:true,
      ...config,device_id:ids
    };
    // Compatibilité : anciennes configurations exprimées en millisecondes.
    // Les anciennes valeurs étaient au minimum de 5000 ms.
    if (Number(this.config.update_interval) >= 5000) {
      this.config.update_interval = Number(this.config.update_interval) / 1000;
    }
    this._registry=null;
    this._painted=false;
    this._signature='';
    this._renderId++;
    this._startTimer();
    this.render();
  }
  static getConfigForm() {
    const bool=n=>({name:n,default:true,selector:{boolean:{}}});
    return {
      schema:[
        {name:'device_id',required:true,selector:{device:{multiple:true,filter:{integration:'sncf_trains'}}}},
        {name:'title',selector:{text:{}}},
        {name:'visible_trains',selector:{number:{min:1,max:10,step:1}}},
        {name:'scroll_trains',selector:{number:{min:1,max:100,step:1}}},
        {name:'direction_titles',selector:{text:{}}},
        {name:'train_lines',selector:{number:{min:1,max:100,step:1}}},
        {name:'animation_duration',selector:{number:{min:0,max:100,step:1}}},
        {name:'update_interval',selector:{number:{min:5,max:3600,step:1}}},
        bool('show_countdown'),bool('show_track'),bool('show_duration'),bool('show_status'),
        bool('show_platform'),bool('show_arrival_platform'),bool('show_train_units'),bool('show_train_type'),
        {name:'train_emoji',selector:{icon:{}}},
        bool('train_emoji_axial_symmetry')
      ],
      computeLabel:s=>({
        device_id:'Appareils SNCF',title:'Titre',visible_trains:'Trains affichés avant Voir plus',scroll_trains:'Trains affichés avant scroll',direction_titles:'Titres des directions (séparés par |)',train_lines:'Nombre de trains',
        animation_duration:'Afficher le train avant départ (minutes)',
        update_interval:'Actualisation (secondes)',
        show_countdown:'Compte à rebours avant le départ',show_track:'Afficher le rail',show_duration:'Afficher la durée',
        show_status:'Afficher le statut',show_platform:'Afficher la voie de départ',show_arrival_platform:'Afficher la voie d’arrivée',
        show_train_units:'Afficher le nombre de rames',show_train_type:'Afficher le matériel roulant',
        train_emoji:'Icône du train',
        train_emoji_axial_symmetry:'Inverser horizontalement le train'
      })[s.name]
    };
  }
  static getStubConfig(){return {device_id:[],title:'Trains SNCF',train_lines:5,visible_trains:3,show_track:true,show_duration:true,show_status:true,show_countdown:true,show_platform:true,show_arrival_platform:true,show_train_units:true,show_train_type:true};}
  set hass(value){
    this._hass=value;
    this.style.setProperty('--sncf-warning-color',value.themes?.darkMode === true ? 'var(--warning-color,#f59e0b)' : '#a65b00');
    this.render();
  }
  connectedCallback(){this._startTimer();}
  disconnectedCallback(){this._stopTimer();this._renderId++;}
  getCardSize(){return Math.max(2,Math.ceil(((this.config?.train_lines||3)+1)/2));}
  _stopTimer(){if(this._timer){clearInterval(this._timer);this._timer=null;}}
  _startTimer(){
    this._stopTimer();
    if(!this.isConnected||!this.config)return;
    this._timer=setInterval(()=>this.render(),Math.max(5,Number(this.config.update_interval)||30)*1000);
  }
  async _entities(){
    if(!this._registry){
      if(!this._registryPromise)this._registryPromise=this._hass.callWS({type:'config/entity_registry/list'})
        .then(data=>{this._registry=data;return data;})
        .finally(()=>{this._registryPromise=null;});
      await this._registryPromise;
    }
    if(!this._deviceRegistryPromise)this._deviceRegistryPromise=this._hass.callWS({type:'config/device_registry/list'})
      .then(data=>{this._deviceRegistry=data;return data;})
      .finally(()=>{this._deviceRegistryPromise=null;});
    await this._deviceRegistryPromise;
    const now=Date.now();
    return this.config.device_id.map(deviceId=>{
      const device=this._deviceRegistry.find(d=>d.id===deviceId);
      const deviceName=String(device?.name_by_user||device?.name||'').replace(/^SNCF\\s+/i,'').trim();
      const deviceEntities=this._registry.filter(e=>e.device_id===deviceId);
      const countEntity=deviceEntities
        .map(e=>this._hass.states[e.entity_id])
        .find(e=>Number.isFinite(Number(e?.attributes?.train_count)));
      const routeLimit=Math.max(1,Number(countEntity?.attributes?.train_count)||1);
      const limit=Math.max(1,Math.min(routeLimit,Number(this.config.train_lines)||routeLimit));
      const updatedAt=deviceEntities
        .map(e=>this._hass.states[e.entity_id]?.attributes?.data_updated_at)
        .filter(Boolean)
        .map(value=>this._date(value))
        .filter(Number.isFinite)
        .reduce((latest,value)=>Math.max(latest,value),0);
      const trains=deviceEntities
        .filter(e=>e.entity_id.startsWith('sensor.')&&e.entity_id.includes('train'))
        .map(e=>this._hass.states[e.entity_id])
        .filter(e=>e?.attributes?.departure_time&&e.attributes.arrival_time)
        .filter(e=>{const t=this._date(e.attributes.arrival_time);return Number.isFinite(t)&&t+30*60000>=now;})
        .sort((a,b)=>this._date(a.attributes.departure_time)-this._date(b.attributes.departure_time))
        .slice(0,limit);
      return {deviceId,deviceName,trains,updatedAt};
    });
  }
  _date(value){
    if(!value)return NaN;
    const m=String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})$/);
    if(m)return new Date(+m[3],+m[2]-1,+m[1],+m[4],+m[5]).getTime();
    return new Date(value).getTime();
  }
  _time(v){const d=this._date(v);return Number.isFinite(d)?new Date(d).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'--:--';}
  _validPlatform(value){const platform=String(value||'').trim();return platform&&!['N/A','UNKNOWN','UNAVAILABLE','NONE','?'].includes(platform.toUpperCase())?platform:'';}
  _trackPlatformChanges(groups){
    const now=Date.now();
    for(const group of groups){
      for(const train of group.trains){
        const id=`${train.entity_id}|${train.attributes.train_num||''}|${train.attributes.departure_time||''}`;
        const platform=this._validPlatform(train.attributes.platform);
        if(!platform)continue;
        const previous=this._platformHistory[id];
        if(previous&&previous!==platform){
          this._platformChanges[id]={from:previous,to:platform,at:now};
        }
        this._platformHistory[id]=platform;
      }
    }
    for(const [id,change] of Object.entries(this._platformChanges)){
      if(now-change.at>10*60*1000)delete this._platformChanges[id];
    }
  }
  _formatAge(timestamp,now=Date.now()){
    const age=Math.max(0,Math.floor((now-timestamp)/1000));
    if(age<10)return "à l'instant";
    if(age<60)return `il y a ${age} s`;
    const minutes=Math.floor(age/60);
    if(minutes<60)return `il y a ${minutes} min`;
    const hours=Math.floor(minutes/60);
    return `il y a ${hours} h ${String(minutes%60).padStart(2,'0')}`;
  }
  _escape(v){return String(v===undefined||v===null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  _icon(value,fallback){
    const v=String(value||fallback||'');
    return /^[a-z][a-z0-9-]*:[a-z0-9-]+$/i.test(v)
      ?`<ha-icon icon="${this._escape(v)}"></ha-icon>`
      :`<span class="emoji">${this._escape(v)}</span>`;
  }
  _line(entity,isNext=false){
    const a=entity.attributes,now=Date.now(),dep=this._date(a.departure_time),arr=this._date(a.arrival_time);
    const baseDep=this._time(a.base_departure_time||a.departure_time);
    const baseArr=this._time(a.base_arrival_time||a.arrival_time);
    const realDep=this._time(a.departure_time),realArr=this._time(a.arrival_time);
    const delay=Math.max(0,Number(a.delay_minutes)||0),late=delay>0||!!a.has_delay;
    const running=now>=dep&&now<arr,arrived=now>=arr;
    const state=late?(delay>15?'late severe':'late moderate'):running?'running':arrived?'arrived':'ontime';
    const label=late?`+${delay} min`:running?'En circulation':arrived?'Arrivé':'À l’heure';
    const duration=Number(a.duration_minutes);
    const progress=arr>dep?Math.max(0,Math.min(100,(now-dep)/(arr-dep)*100)):0;
    const showTrain=running;
    const time=(base,real)=>late&&base!==real
      ?`<span class="original">${this._escape(base)}</span><span class="actual">${this._escape(real)}</span>`
      :`<span class="actual">${this._escape(real)}</span>`;
    const durationLabel=Number.isFinite(duration)&&duration>0?`${Math.round(duration)} min`:'';
    const platform=this._validPlatform(a.platform);
    const showPlatform=this.config.show_platform&&!!platform;
    const platformChange=this._platformChanges[entity.entity_id];
    const showPlatformChange=!!platformChange&&Date.now()-platformChange.at<=10*60*1000;
    const platformChangeNotice=showPlatformChange?`<span class="platform-changed"><ha-icon icon="mdi:swap-horizontal"></ha-icon>Voie modifiée</span>`:'';
    const arrivalPlatform=String(a.arrival_platform||'').trim();
    const showArrivalPlatform=this.config.show_arrival_platform&&arrivalPlatform&&!['N/A','UNKNOWN','UNAVAILABLE','NONE'].includes(arrivalPlatform.toUpperCase());
    const arrivalInfo=showArrivalPlatform?`<div class="platform-line arrival-platform"><span class="platform-label">Voie</span><strong>${this._escape(arrivalPlatform)}</strong></div>`:'';
    const units=Number(a.train_units);
    const showUnits=this.config.show_train_units&&Number.isInteger(units)&&units>0;
    const trainType=String(a.train_type||'').trim();
    const showType=this.config.show_train_type&&trainType;
    const trainNumber=String(a.train_num||'').trim();
    const trainLabel=trainNumber? `TER ${trainNumber}` : 'TER';
    const expanded=!!this._expanded[entity.entity_id];
    const departureInfo=showPlatform?`<div class="platform-line departure-platform"><span class="platform-badge">Voie ${this._escape(platform)}</span></div>`:'';
    const trainInfo=[
      showUnits?`<span class="train-detail"><ha-icon icon="mdi:train-variant"></ha-icon>${units} ${units===1?'rame':'rames'}</span>`:'',
      showType?`<span class="train-detail train-type">${this._escape(trainType)}</span>`:''
    ].filter(Boolean).join('');
    const countdown=this.config.show_countdown&&now<dep?`<span class="countdown" data-departure="${dep}">${this._countdown(dep,now)}</span>`:'';
    return `<article class="train-row ${state} ${isNext?'next-train':''} ${expanded?'expanded':''}" data-train-id="${this._escape(entity.entity_id)}" role="button" tabindex="0" aria-expanded="${expanded}">
      <div class="journey">
        <div class="station depart"><span class="station-caption">Départ</span>
          <div class="times">${time(baseDep,realDep)}</div>${departureInfo}</div>
        <div class="middle">
          ${this.config.show_track?`<div class="track">
            <div class="track-fill" style="width:${running||arrived?progress:0}%"></div>
            ${showTrain?`<span class="moving-train" style="left:${progress}%">${this._icon(this.config.train_emoji,'mdi:train')}</span>`:''}
          </div>`:'<ha-icon icon="mdi:arrow-right"></ha-icon>'}
        </div>
        <div class="station arrive"><span class="station-caption">Arrivée</span>
          <div class="times">${time(baseArr,realArr)}</div>${arrivalInfo}</div>
      </div>
      <div class="train-footer">
        <div class="train-meta"><span class="ter-pill">${this._escape(trainLabel)}</span>
          ${trainInfo?`<span class="train-details">${trainInfo}</span>`:''}
          ${this.config.show_duration&&durationLabel?`<span class="duration"><ha-icon icon="mdi:clock-outline"></ha-icon>${durationLabel}</span>`:''}
          ${countdown}${platformChangeNotice}
        </div>
        ${this.config.show_status?`<span class="status"><span class="dot"></span>${label}</span>`:''}
      </div>
      ${this._stopDetails(entity,expanded)}
      <div class="expand-chevron" aria-hidden="true"><ha-icon icon="mdi:chevron-down"></ha-icon></div>
    </article>`;
  }
  _stopDetails(entity,expanded){
    const stops=Array.isArray(entity.attributes.stops)?entity.attributes.stops:[];
    if(!stops.length)return '';
    const now=Date.now();
    const eventTimes=stops.map(stop=>{
      // Une gare est considérée atteinte à l'heure d'arrivée, pas au départ.
      return this._date(stop.arrival_time||stop.departure_time);
    });
    const validTimes=eventTimes.filter(Number.isFinite);
    const position=this._stopPosition(validTimes,now);
    const rows=stops.map((stop,index)=>{
      const arrival=String(stop.arrival_time||'').trim();
      const departure=String(stop.departure_time||'').trim();
      const baseArrival=String(stop.base_arrival_time||'').trim();
      const baseDeparture=String(stop.base_departure_time||'').trim();
      const eventTime=this._date(arrival||departure);
      const passed=Number.isFinite(eventTime)&&now>=eventTime;
      const nextStopIndex=eventTimes.findIndex(time=>Number.isFinite(time)&&time>now);
      const isNextStop=index===nextStopIndex;
      const platform=String(stop.platform||'').trim();
      const validPlatform=platform&&!['N/A','UNKNOWN','UNAVAILABLE','NONE','?'].includes(platform.toUpperCase());
      const actualTimes=[
        arrival? `<span class="stop-time"><small>Arr.</small><strong>${this._time(arrival)}</strong></span>`:'',
        departure? `<span class="stop-time departure-time"><small>Départ</small><strong>${this._time(departure)}</strong><span class="stop-platform-slot">${validPlatform?`<span class="stop-platform-badge">${this._escape(platform)}</span>`:''}</span></span>`:''
      ].filter(Boolean).join('');
      const baseTimes=[
        baseArrival? `ARR. ${this._time(baseArrival)}`:'',
        baseDeparture? `DÉPART ${this._time(baseDeparture)}`:''
      ].filter(Boolean);
      const showBase=Number(entity.attributes.delay_minutes)>0&&baseTimes.length;
      return `<div class="stop-row ${passed?'passed':''} ${isNextStop?'next-stop':''}">
        <span class="stop-dot"></span>
        <span class="stop-name">${this._escape(stop.name||'Gare inconnue')}${isNextStop?'<small class="next-stop-label">PROCHAINE</small>':''}</span>
        <span class="stop-times"><span class="stop-time-list">${actualTimes||'<span class="stop-time"><strong>--:--</strong></span>'}</span>${showBase?`<small>${this._escape(baseTimes.join(' · '))}</small>`:''}</span>
      </div>`;
    }).join('');
    const height=Math.max(36,(stops.length-1)*36);
    return `<div class="stop-details" style="height:${expanded?stops.length*36:0}px;max-height:${expanded?stops.length*36+40:0}px;margin-top:${expanded?12:0}px;opacity:${expanded?1:0}">
      <div class="stop-timeline" data-times="${eventTimes.join(',')}" style="height:${stops.length*36}px">
        <div class="stop-rail"></div>
        <div class="stop-rail-fill" style="height:${position*36}px"></div>
        <span class="stop-train-marker" style="top:${17+position*36}px">${this._icon(this.config.train_emoji,'mdi:train')}</span>
        ${rows}
      </div>
    </div>`;
  }
  _stopPosition(times,now){
    if(!times.length)return 0;
    if(now<=times[0])return 0;
    if(now>=times[times.length-1])return times.length-1;
    for(let i=0;i<times.length-1;i++){
      if(now>=times[i]&&now<=times[i+1]){
        const span=times[i+1]-times[i];
        return i+(span>0?(now-times[i])/span:0);
      }
    }
    return 0;
  }
  _countdown(dep,now=Date.now()){
    const diff=dep-now;
    if(!Number.isFinite(diff)||diff<=0)return '';
    const minutes=Math.ceil(diff/60000);
    if(minutes>=1440)return `Dans ${Math.floor(minutes/1440)} j`;
    if(minutes>=60)return `Dans ${Math.floor(minutes/60)} h ${String(minutes%60).padStart(2,'0')}`;
    return `Dans ${minutes} min`;
  }
  _updateLive(groups){
    const now=Date.now();
    const freshness=this.shadowRoot.querySelector('[data-data-freshness]');
    if(freshness){
      const index=Math.max(0,Math.min(this._activeDirection,groups.length-1));
      const updatedAt=Number(groups[index]?.updatedAt);
      freshness.textContent=updatedAt>0?`Données actualisées ${this._formatAge(updatedAt,now)}`:'Actualisation indisponible';
    }
    const nextContainer=this.shadowRoot.querySelector('[data-next-departure]');
    if(nextContainer){
      const index=Math.max(0,Math.min(this._activeDirection,groups.length-1));
      const next=this._nextTrain(groups[index],now);
      if(next){
        const departure=this._date(next.attributes.departure_time);
        const platform=String(next.attributes.platform||'').trim();
        const validPlatform=platform&&!['N/A','UNKNOWN','UNAVAILABLE','NONE'].includes(platform.toUpperCase());
        nextContainer.innerHTML=`<ha-icon icon="mdi:clock-fast"></ha-icon><span>Prochain train ${this._countdown(departure,now).toLowerCase()}</span>${validPlatform?`<span class="next-platform">Voie ${this._escape(platform)}</span>`:''}`;
        nextContainer.classList.remove('empty-next');
      }else{
        nextContainer.textContent='Aucun prochain train';
        nextContainer.classList.add('empty-next');
      }
    }
    this.shadowRoot.querySelectorAll('[data-departure]').forEach(el=>{
      const dep=Number(el.dataset.departure);
      el.textContent=this._countdown(dep,now);
      el.hidden=now>=dep;
    });
    this.shadowRoot.querySelectorAll('.stop-timeline').forEach(timeline=>{
      const rawTimes=String(timeline.dataset.times||'').split(',').map(Number);
      const times=rawTimes.filter(Number.isFinite);
      const position=this._stopPosition(times,now);
      const fill=timeline.querySelector('.stop-rail-fill');
      const marker=timeline.querySelector('.stop-train-marker');
      if(fill)fill.style.height=`${position*36}px`;
      if(marker)marker.style.top=`${17+position*36}px`;
      const now=Date.now();
      const nextIndex=rawTimes.findIndex(time=>Number.isFinite(time)&&time>now);
      timeline.querySelectorAll('.stop-row').forEach((row,index)=>{
        const eventTime=rawTimes[index];
        const isNext=index===nextIndex;
        row.classList.toggle('passed',Number.isFinite(eventTime)&&now>=eventTime);
        row.classList.toggle('next-stop',isNext);
        const name=row.querySelector('.stop-name');
        if(name){
          const label=name.querySelector('.next-stop-label');
          if(isNext&&!label)name.insertAdjacentHTML('beforeend','<small class="next-stop-label">PROCHAINE</small>');
          if(!isNext&&label)label.remove();
        }
      });
    });
  }
  _nextTrain(group,now=Date.now()){
    if(!group?.trains?.length)return null;
    return group.trains
      .filter(train=>this._date(train.attributes.departure_time)>now)
      .sort((a,b)=>this._date(a.attributes.departure_time)-this._date(b.attributes.departure_time))[0]||null;
  }
  _directionName(group,index){
    const configured=String(this.config.direction_titles||'').split('|').map(s=>s.trim());
    if(configured[index])return configured[index];
    // Prefer the route configured in the Home Assistant device name.
    // The SNCF API's direction can be a destination label repeated twice.
    if(group.deviceName)return group.deviceName;
    const a=group.trains[0]?.attributes;
    return a?.route_name||a?.direction||`Trajet ${index+1}`;
  }
  _view(groups){
    if(!groups.length)return '<p class="empty">Aucun trajet configuré.</p>';
    const index=Math.max(0,Math.min(this._activeDirection,groups.length-1));
    const group=groups[index],count=group.trains.length;
    const visible=Math.max(1,Number(this.config.visible_trains)||3);
    const expanded=!!this._expanded[group.deviceId];
    const shown=expanded?group.trains:group.trains.slice(0,visible);
    const nextTrain=this._nextTrain(group);
    const nextTrainId=nextTrain?.entity_id;
    const name=this._escape(this._directionName(group,index));
    return `<nav aria-label="Choix du sens">
       <button type="button" class="arrow-btn" data-prev aria-label="Sens précédent"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
       <div class="direction-label"><span>${name}</span><small>${index+1} / ${groups.length} · ${count} trains</small><div class="next-departure" data-next-departure></div><div class="data-freshness" data-data-freshness></div></div>
       <button type="button" class="arrow-btn" data-next aria-label="Sens suivant"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
       <button type="button" class="cancellation-info" aria-label="Information sur les trains supprimés" aria-expanded="false" data-tooltip="Les trains supprimés ne sont pas pris en compte."><ha-icon icon="mdi:alert-circle-outline"></ha-icon></button>
     </nav>
     <div class="direction-dots" aria-hidden="true">${groups.map((g,i)=>`<span class="${i===index?'active':''}"></span>`).join('')}</div>
     <div class="trains">${shown.length?shown.map(t=>this._line(t,t.entity_id===nextTrainId)).join(''):'<p class="empty">Aucun train disponible pour ce sens.</p>'}</div>
     ${count>visible?`<button type="button" class="more" data-more aria-expanded="${expanded}">${expanded?'Voir moins':`Voir plus (${count-visible} trains)`} <ha-icon icon="mdi:chevron-${expanded?'up':'down'}"></ha-icon></button>`:''}
`;
  }
  _applyTrainScroll(){
    const container=this.shadowRoot.querySelector('.trains');
    if(!container)return;
    const limit=Number(this.config.scroll_trains);
    const rows=container.querySelectorAll('.train-row');
    container.classList.remove('scrollable');
    container.style.maxHeight='';
    if(!Number.isInteger(limit)||limit<1||rows.length<=limit)return;
    const containerTop=container.getBoundingClientRect().top;
    const lastVisible=rows[limit-1];
    const maxHeight=lastVisible.getBoundingClientRect().bottom-containerTop;
    if(maxHeight>0){
      container.style.maxHeight=`${maxHeight}px`;
      container.classList.add('scrollable');
    }
  }
  _attachActions(groups){
    const panel=this.shadowRoot.querySelector('.panel');
    const cardHeader=this.shadowRoot.querySelector('[data-collapse-toggle]');
    const toggleCard=()=>{
      this._collapsed=!this._collapsed;
      const card=this.shadowRoot.querySelector('ha-card');
      card?.classList.toggle('collapsed',this._collapsed);
      cardHeader?.setAttribute('aria-expanded',String(!this._collapsed));
      const chevron=cardHeader?.querySelector('.collapse-chevron');
      // Le chevron reste orienté vers le haut et pivote de 180° à la fermeture.
    };
    cardHeader?.addEventListener('click',event=>{if(!event.target.closest('button'))toggleCard();});
    cardHeader?.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target===cardHeader){event.preventDefault();toggleCard();}});
    this.shadowRoot.querySelector('[data-refresh]')?.addEventListener('click',async event=>{
      event.stopPropagation();
      const button=event.currentTarget;
      if(button.disabled)return;
      button.disabled=true;
      button.classList.add('refreshing');
      try{
        await this._hass.callService('sncf_trains','refresh');
      }catch(error){
        console.error('SNCF Train Card: impossible de rafraîchir les données',error);
      }finally{
        button.disabled=false;
        button.classList.remove('refreshing');
      }
    });
    const cancellationInfo=panel.querySelector('.cancellation-info');
    cancellationInfo?.addEventListener('click',event=>{
      event.stopPropagation();
      const nav=cancellationInfo.closest('nav');
      nav?.classList.toggle('show-cancellation-tooltip');
      cancellationInfo.setAttribute('aria-expanded',String(nav?.classList.contains('show-cancellation-tooltip')));
    });
    panel.addEventListener('click',event=>{
      if(event.target.closest('.cancellation-info'))return;
      panel.querySelector('nav.show-cancellation-tooltip')?.classList.remove('show-cancellation-tooltip');
      panel.querySelector('.cancellation-info')?.setAttribute('aria-expanded','false');
    });
    const previousButton=panel.querySelector('[data-prev]');
    previousButton?.addEventListener('click',()=>{
      this._activeDirection=(this._activeDirection+groups.length-1)%groups.length;this._updatePanel(groups);
    });
    panel.querySelector('[data-next]')?.addEventListener('click',()=>{
      this._activeDirection=(this._activeDirection+1)%groups.length;this._updatePanel(groups);
    });
    panel.querySelector('[data-more]')?.addEventListener('click',()=>{
      const id=groups[this._activeDirection].deviceId;
      this._expanded[id]=!this._expanded[id];
      this._updatePanel(groups);
    });
    panel.querySelectorAll('.train-row[data-train-id]').forEach(row=>{
      const toggle=()=>{
        const id=row.dataset.trainId;
        const expanded=!this._expanded[id];
        this._expanded[id]=expanded;
        row.classList.toggle('expanded',expanded);
        row.setAttribute('aria-expanded',String(expanded));
        const details=row.querySelector('.stop-details');
        if(details){
          details.style.height=expanded?`${details.scrollHeight}px`:'0px';
          details.style.maxHeight=expanded?`${details.scrollHeight}px`:'0px';
          details.style.marginTop=expanded?'12px':'0px';
          details.style.opacity=expanded?'1':'0';
        }
        this._applyTrainScroll();
      };
      row.addEventListener('click',toggle);
      row.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){
          event.preventDefault();
          toggle();
        }
      });
    });
  }
  _updatePanel(groups){
    const panel=this.shadowRoot.querySelector('.panel');
    if(!panel)return;
    panel.innerHTML=this._view(groups);
    this._applyTrainScroll();
    this._attachActions(groups);
    this._updateLive(groups);
  }
  async render(){
    if(!this.config||!this._hass||!this.isConnected)return;
    const id=++this._renderId;
    try{
      const groups=await this._entities();
      if(id!==this._renderId||!this.isConnected)return;
      this._trackPlatformChanges(groups);
      const signature=JSON.stringify(groups.map(g=>[g.deviceId,g.trains.map(t=>[
        t.entity_id,t.attributes.departure_time,t.attributes.arrival_time,
        t.attributes.base_departure_time,t.attributes.base_arrival_time,
        t.attributes.delay_minutes,t.attributes.has_delay,
        t.attributes.platform,t.attributes.arrival_platform,t.attributes.train_units,t.attributes.train_type,
        t.attributes.train_num,t.attributes.stops
      ])]));
      // Avoid replacing the DOM on every Home Assistant state update.
      // This prevents focus/scroll jumps on iOS.
      if(this._painted&&signature===this._signature){this._updateLive(groups);return;}
      this._signature=signature;
      if(!this._painted){
        this.shadowRoot.innerHTML=`<style>${this._css()}</style><ha-card>
          <header class="card-header" data-collapse-toggle role="button" tabindex="0" aria-expanded="true"><span class="title-icon"><ha-icon icon="mdi:train"></ha-icon></span><span class="card-title">${this._escape(this.config.title)}</span><button type="button" class="refresh-btn" data-refresh aria-label="Actualiser les données" title="Actualiser les données"><ha-icon icon="mdi:refresh"></ha-icon></button><ha-icon class="collapse-chevron" icon="mdi:chevron-up"></ha-icon></header>
          <div class="panel"></div></ha-card>`;
        this._painted=true;
      }
      this._updatePanel(groups);
    }catch(e){
      if(id!==this._renderId)return;
      if(!this._painted){
        this.shadowRoot.innerHTML=`<ha-card><div style="padding:16px">Impossible de charger les trains : ${this._escape(e.message)}</div></ha-card>`;
      }
    }
  }
  _css(){return `
:host{display:block;min-width:0;max-width:100%;overflow-anchor:none;--accent:var(--primary-color,#4c91ff)}
*{box-sizing:border-box}
ha-card{width:100%;max-width:100%;min-width:0;background:var(--ha-card-background,var(--card-background-color));color:var(--primary-text-color);border-radius:28px;overflow:hidden;border:0;box-shadow:0 8px 24px rgba(0,0,0,.08)}
.train-details{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:.72rem;color:var(--secondary-text-color);min-width:0}
 .platform-line{display:inline-flex;align-items:center;gap:5px;margin-top:7px;white-space:nowrap}\n.platform-badge{display:inline-flex;align-items:center;justify-content:center;height:17px;box-sizing:border-box;padding:0 7px;border-radius:9px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:.76rem;line-height:17px;font-weight:750;white-space:nowrap}\n.arrival-platform{align-self:flex-end;justify-content:flex-end}\n.train-detail{display:inline-flex;align-items:center;gap:4px;min-width:0}
.train-detail ha-icon{--mdc-icon-size:15px;flex-shrink:0}
.platform-inline{font-weight:650;color:var(--primary-text-color)}
.platform-inline strong{font-size:.95rem;font-weight:850;color:var(--primary-color,#03a9f4)}
.train-type{overflow-wrap:anywhere}
.card-header{display:flex;align-items:center;gap:10px;height:56px;min-height:56px;margin:8px 6px;padding:7px 6px 7px 0;border-radius:28px;background:#262626;color:#fff;font-weight:700;font-size:.9rem;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:background-color .2s ease}
.title-icon{display:grid;place-items:center;flex:0 0 40px;width:40px;height:40px;border-radius:50%;background:#171717;color:#fff}
.title-icon ha-icon{--mdc-icon-size:20px}
.card-title{flex:1;min-width:0;font-size:.9rem;font-weight:700;line-height:1.2}
.collapse-chevron{flex:0 0 auto;color:#fff;--mdc-icon-size:24px;transition:transform .28s ease}
.card-header .refresh-btn{margin-left:auto;background:transparent;color:#fff}
ha-card .panel{display:block;max-height:10000px;opacity:1;transform:translateY(0);overflow:hidden;transition:max-height .36s ease,opacity .24s ease,transform .36s ease}
ha-card.collapsed .panel{display:block;max-height:0;opacity:0;transform:translateY(-7px);pointer-events:none}
ha-card.collapsed .collapse-chevron{transform:rotate(180deg)}
ha-card.collapsed .card-header{margin:0 6px;height:56px;min-height:56px}
.refresh-btn{margin-left:auto;display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;padding:0;border:0;border-radius:50%;background:var(--secondary-background-color,rgba(100,120,160,.12));color:var(--accent);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.refresh-btn ha-icon{--mdc-icon-size:20px;color:#fff}
.refresh-btn[disabled]{opacity:.55;cursor:default}
.refresh-btn.refreshing ha-icon{animation:sncf-refresh-spin .8s linear infinite}
@keyframes sncf-refresh-spin{to{transform:rotate(360deg)}}
.panel,.trains{overflow-anchor:none;min-width:0;max-width:100%}
nav{display:flex;align-items:center;gap:7px;margin:2px 12px 0;padding:8px 5px;border-radius:15px;background:var(--secondary-background-color,rgba(100,120,160,.09));border:1px solid var(--divider-color)}
nav{position:relative}
.cancellation-info{position:absolute;top:5px;right:7px;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--secondary-text-color);cursor:pointer;z-index:3}
.cancellation-info ha-icon{--mdc-icon-size:18px}
.cancellation-info::after{content:attr(data-tooltip);position:absolute;top:32px;right:0;width:max-content;max-width:min(230px,70vw);padding:9px 11px;border:1px solid var(--divider-color);border-radius:9px;background:var(--card-background-color);color:var(--primary-text-color);font-size:.72rem;font-weight:500;line-height:1.35;text-align:left;white-space:normal;box-shadow:0 4px 14px rgba(0,0,0,.3);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}
.cancellation-info:hover::after,.cancellation-info:focus-visible::after,nav.show-cancellation-tooltip .cancellation-info::after{opacity:1;visibility:visible;transform:translateY(0)}
.arrow-btn{display:grid;place-items:center;flex:0 0 36px;width:36px;height:38px;border:0;border-radius:11px;background:var(--card-background-color,rgba(100,120,160,.15));color:var(--accent);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.direction-label{flex:1;min-width:0;text-align:center;line-height:1.3}
.direction-label span{display:block;font-size:.92rem;font-weight:750;overflow-wrap:anywhere}
.direction-label small{display:block;color:var(--secondary-text-color);font-size:.7rem;margin-top:4px}
.next-departure{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:5px;margin-top:6px;color:var(--accent);font-size:.72rem;font-weight:750}
.next-departure ha-icon{--mdc-icon-size:15px}
.next-departure.empty-next{color:var(--secondary-text-color);font-weight:500}
.data-freshness{margin-top:3px;color:var(--secondary-text-color);font-size:.62rem;font-weight:500;line-height:1.2;text-align:right}
.platform-changed{display:inline-flex;align-items:center;gap:3px;padding:3px 6px;border-radius:7px;background:color-mix(in srgb,var(--warning-color,#f59e0b) 14%,transparent);color:var(--warning-color,#f59e0b);font-size:.65rem;font-weight:750;white-space:nowrap}
.platform-changed ha-icon{--mdc-icon-size:13px}
 .next-platform{display:inline-flex;align-items:center;justify-content:center;height:17px;box-sizing:border-box;padding:0 7px;border-radius:9px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:.75rem;line-height:17px;font-weight:750;white-space:nowrap}
.direction-dots{display:flex;justify-content:center;gap:6px;padding:10px 0 5px}
.direction-dots span{width:5px;height:5px;border-radius:9px;background:var(--divider-color)}
.direction-dots span.active{width:19px;background:var(--accent)}
.trains{padding:2px 12px 0}
.trains.scrollable{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--divider-color) transparent}
.train-row{min-width:0;max-width:100%;overflow:hidden;padding:13px 12px 0;margin:9px 0;border-radius:15px;border:1px solid var(--divider-color);background:var(--secondary-background-color,rgba(100,120,160,.07));cursor:pointer;-webkit-tap-highlight-color:transparent}
.train-row.next-train{border-color:var(--accent)}
.stop-details{height:0;overflow:hidden;max-width:100%;border-top:1px solid var(--divider-color);margin-top:0;transition:height .35s cubic-bezier(.4,0,.2,1),max-height .35s cubic-bezier(.4,0,.2,1),margin-top .35s cubic-bezier(.4,0,.2,1),opacity .25s ease}
.stop-timeline{position:relative;padding:0 8px 0 18px;min-height:36px}
.stop-rail{position:absolute;left:28px;top:17px;bottom:17px;width:2px;background:var(--divider-color)}
.stop-rail-fill{position:absolute;left:28px;top:17px;width:2px;background:var(--accent);transition:height .5s ease}
.stop-row{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;min-height:36px;gap:6px;z-index:1}
.stop-dot{width:8px;height:8px;margin-left:6px;border-radius:50%;background:var(--secondary-text-color);border:2px solid var(--secondary-background-color,var(--card-background-color));box-shadow:0 0 0 1px var(--secondary-text-color);transform:translateX(1px)}
.stop-row.passed .stop-dot{background:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.stop-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.76rem;color:var(--primary-text-color)}
.stop-row.passed .stop-name{color:var(--accent)}
.stop-row.next-stop .stop-name{color:var(--primary-text-color);font-weight:500}
.stop-row.next-stop .stop-dot{background:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.next-stop-label{display:inline-flex;align-items:center;margin-left:6px;padding:2px 5px;border-radius:5px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:.52rem;font-weight:800;letter-spacing:.02em;vertical-align:middle}
.late.moderate .stop-train-marker,.late.moderate .next-stop-label{color:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.severe .stop-train-marker,.late.severe .next-stop-label{color:var(--error-color,#e53935)}
.stop-times{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:.69rem;font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}
.stop-time-list{display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:nowrap}
 .stop-time{display:flex;align-items:center;gap:5px;min-height:17px}
 .departure-time{gap:5px}.stop-platform-slot{display:inline-flex;align-items:center;justify-content:flex-start;flex:0 0 34px;width:34px;height:17px}.stop-platform-badge{display:inline-flex;align-items:center;justify-content:center;padding:0 5px;min-width:22px;height:17px;box-sizing:border-box;border-radius:9px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:.74rem;font-weight:750;line-height:17px;white-space:nowrap}.stop-platform{font-size:.59rem;color:var(--secondary-text-color);font-weight:650;white-space:nowrap}
.stop-time small{font-size:.57rem;color:var(--secondary-text-color);font-weight:650;text-transform:uppercase;letter-spacing:.03em}
.stop-time strong{font-size:.69rem;font-weight:700}
.stop-times>small{font-size:.62rem;color:var(--primary-text-color);opacity:.9;text-decoration:line-through;text-decoration-color:var(--secondary-text-color);text-decoration-thickness:1px;font-weight:500}
.stop-train-marker{position:absolute;left:17px;transform:translateY(-50%);width:24px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--secondary-background-color,var(--card-background-color));color:var(--accent);z-index:2;transition:top .5s ease}
.stop-train-marker ha-icon{--mdc-icon-size:16px;color:inherit}
.stop-train-marker .emoji{font-size:15px;line-height:1;color:inherit}
.expand-chevron{display:flex;justify-content:center;align-items:center;height:18px;margin:0 -12px;color:var(--secondary-text-color);opacity:.8}
.expand-chevron ha-icon{--mdc-icon-size:19px;transition:transform .3s ease}
.train-row.expanded .expand-chevron ha-icon{transform:rotate(180deg)}
.late.moderate .stop-rail-fill,.late.moderate .stop-row.passed .stop-dot{background:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.moderate .stop-row.passed .stop-dot{box-shadow:0 0 0 1px var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.moderate .stop-row.passed .stop-name{color:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.severe .stop-rail-fill,.late.severe .stop-row.passed .stop-dot{background:var(--error-color,#e53935)}
.late.severe .stop-row.passed .stop-dot{box-shadow:0 0 0 1px var(--error-color,#e53935)}
.late.severe .stop-row.passed .stop-name{color:var(--error-color,#e53935)}
.train-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.stop-details,.expand-chevron ha-icon,.stop-train-marker,.stop-rail-fill{transition:none}}
.journey{display:grid;grid-template-columns:minmax(0,auto) minmax(16px,1fr) minmax(0,auto);align-items:center;gap:8px;min-width:0;width:100%}
.station{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:100%}\n.station.depart{overflow:visible}
.station.arrive{text-align:right}
.station-caption{font-size:.59rem;text-transform:uppercase;letter-spacing:.08em;color:var(--secondary-text-color);font-weight:650}
.times{display:flex;flex-direction:column;gap:2px;line-height:1.15;font-variant-numeric:tabular-nums}
 .actual{font-size:clamp(.94rem,4.5vw,1.27rem);font-weight:800;letter-spacing:-.035em;white-space:nowrap}
.original{font-size:.72rem;color:var(--secondary-text-color);text-decoration:line-through}
.middle{min-width:16px;display:flex;align-items:center;justify-content:center;position:relative}
.track{height:4px;width:100%;position:relative;border-radius:9px;background:var(--divider-color)}
.track::before,.track::after{content:'';position:absolute;top:-3px;width:10px;height:10px;border-radius:50%;background:var(--secondary-text-color);opacity:.55}
.track::before{left:0}.track::after{right:0}
.track-fill{height:100%;background:var(--accent);border-radius:9px;transition:width .5s ease}
.moving-train{position:absolute;top:-26px;transform:translateX(-50%);color:var(--accent);transition:left .5s ease}
.moving-train ha-icon{--mdc-icon-size:23px}
.train-footer{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:7px;margin-top:12px;min-width:0}
.train-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;color:var(--secondary-text-color);font-size:.72rem}
.ter-pill{padding:3px 7px;border:1px solid var(--divider-color);border-radius:7px;font-size:.66rem;font-weight:750}
.duration{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.duration ha-icon{--mdc-icon-size:14px}
.countdown{color:var(--accent);font-weight:700;white-space:nowrap}
.countdown[hidden]{display:none}
.status{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:9px;background:color-mix(in srgb,var(--success-color,#43a047) 12%,transparent);color:var(--success-color,#43a047);font-size:.72rem;font-weight:750;white-space:nowrap}
.dot{height:7px;width:7px;border-radius:50%;background:currentColor}
.late.moderate .actual,.late.moderate .status{color:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.severe .actual,.late.severe .status{color:var(--error-color,#e53935)}
.late.moderate .status{background:color-mix(in srgb,var(--sncf-warning-color,var(--warning-color,#f59e0b)) 12%,transparent)}
.late.severe .status{background:color-mix(in srgb,var(--error-color,#e53935) 12%,transparent)}
.late.moderate .track-fill{background:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.severe .track-fill{background:var(--error-color,#e53935)}
.late.moderate .moving-train{color:var(--sncf-warning-color,var(--warning-color,#f59e0b))}
.late.severe .moving-train{color:var(--error-color,#e53935)}
.running .status{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.arrived .status{color:var(--secondary-text-color);background:var(--secondary-background-color)}
.cancellation-note{display:flex;align-items:flex-start;justify-content:center;gap:6px;margin:10px 10px 10px;color:var(--secondary-text-color);font-size:.69rem;line-height:1.4;text-align:center}.cancellation-note ha-icon{--mdc-icon-size:15px;flex-shrink:0}
.more{display:flex;justify-content:center;align-items:center;gap:8px;width:calc(100% - 24px);margin:12px;padding:13px;border:1px solid var(--divider-color);border-radius:12px;background:var(--secondary-background-color,rgba(100,120,160,.09));color:var(--accent);font-size:.85rem;font-weight:750;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.more ha-icon{--mdc-icon-size:19px}
.empty{padding:20px;text-align:center;color:var(--secondary-text-color)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:370px){.trains{padding:2px 8px 0}.train-row{padding:11px 9px}.actual{font-size:1.1rem}.journey{gap:6px}}
@media(prefers-reduced-motion:reduce){.moving-train,.track-fill{transition:none}}
  `;}
}
if(!customElements.get('sncf-train-card'))customElements.define('sncf-train-card',SncfTrainCard);