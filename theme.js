/* Theme preference: "system" (default, follows the OS), "light" or "dark".
 * Loaded synchronously in <head> so the right theme is applied before the
 * first paint. The choice is a per-browser convenience (localStorage). */
(function(){
  var KEY = "ld-theme";
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  var listeners = [];

  function read(){
    try{
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    }catch(e){
      return "system";
    }
  }

  function resolve(pref){
    if(pref === "light" || pref === "dark") return pref;
    return media && media.matches ? "light" : "dark";
  }

  function apply(){
    var pref = read();
    var root = document.documentElement;
    root.setAttribute("data-theme", resolve(pref));
    root.setAttribute("data-theme-pref", pref);
    listeners.forEach(function(fn){ try{ fn(pref, resolve(pref)); }catch(e){} });
  }

  function set(pref){
    try{
      if(pref === "light" || pref === "dark") localStorage.setItem(KEY, pref);
      else localStorage.removeItem(KEY);
    }catch(e){}
    apply();
  }

  if(media){
    var onChange = function(){ if(read() === "system") apply(); };
    if(media.addEventListener) media.addEventListener("change", onChange);
    else if(media.addListener) media.addListener(onChange);
  }
  // Same preference across tabs (site and admin).
  window.addEventListener("storage", function(e){ if(e.key === KEY) apply(); });

  window.LDTheme = {
    get: read,
    set: set,
    resolved: function(){ return resolve(read()); },
    onChange: function(fn){ listeners.push(fn); },
    labels: { system: "Automatico", light: "Chiaro", dark: "Scuro" },
  };
  apply();
})();
