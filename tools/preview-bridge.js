(function () {
  var callbacks = [];
  var art = null;
  var snapshot;
  function data(mode) {
    var now = Date.now();
    return {schemaVersion:1,settings:EndfieldCore.sanitizeSettings({characterName:art?'自定义立绘':''}),
      stamina: mode === 'empty' ? null : {current:mode==='zero'?0:mode==='full'?240:128,max:240,
        updatedAt:mode==='error'?now-7200000:now,recoveryAt:now+112*360000,secondsPerPoint:null},
      profile:mode==='empty'?null:{name:'管理员#1234',level:45,server:'国服 · 示例数据'},portrait:art?{dataUrl:art}:null,syncedAt:mode==='error'?now-7200000:now,
      dashboard:mode==='empty'?null:{glory:{count:126,medals:[
        {id:'demo1',name:'开拓旅程 · 示例奖章',category:'探索成就',level:3,isPlated:true},
        {id:'demo2',name:'并肩前行 · 示例奖章',category:'干员成就',level:2,isPlated:false},
        {id:'demo3',name:'工业之光 · 示例奖章',category:'建设成就',level:1,isPlated:false}]},
        operatorCount:26,operators:[{id:'demo1',name:'演示干员 A',level:80,evolvePhase:4,potentialLevel:2,
          weapon:{name:'演示武器',level:80,refineLevel:2,breakthroughLevel:4},
          skills:[{id:'s1',name:'普通攻击',level:9},{id:'s2',name:'战技',level:9},{id:'s3',name:'连携技',level:8},{id:'s4',name:'终结技',level:9}],
          equipment:[{slot:'bodyEquip',name:'演示护甲',level:'60'},{slot:'armEquip',name:'演示护手',level:'60'}]},
          {id:'demo2',name:'演示干员 B',level:60,evolvePhase:3,potentialLevel:0,weapon:null,skills:[],equipment:[]}],
        operatorsTruncated:false,medalsTruncated:false},
      error:mode==='error'?'同步失败':null};
  }
  snapshot=data('normal');
  window.showState=function(mode){snapshot=data(mode);callbacks.forEach(function(fn){fn()});};
  window.bridge={card:{readSnapshot:function(){return snapshot},onRefresh:function(fn){callbacks.push(fn)}},config:{onChange:function(){}}};
  window.EndfieldService={create:function(){return {getSettings:async function(){return snapshot.settings},getSnapshot:async function(){return snapshot},refresh:async function(){return snapshot}}}};
  document.getElementById('art').addEventListener('change',function(event){
    var file=event.target.files[0];if(!file)return;
    var reader=new FileReader();reader.onload=function(){art=reader.result;showState('normal')};reader.readAsDataURL(file);
  });
})();
