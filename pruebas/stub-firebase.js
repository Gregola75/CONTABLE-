/* Firebase simulado para probar la sincronización sin tocar la nube real. */
(() => {
  const nombres = ['registros', 'proveedores', 'personal', 'pagos', 'borrados'];
  const data = {}; const listeners = {};
  nombres.forEach(n => { data[n] = new Map(); listeners[n] = []; });
  let user = null, authCb = null;
  const snap = (n) => ({ docs: [...data[n].entries()].map(([id, d]) => ({ id, data: () => d })) });
  const fire = (n) => listeners[n].forEach(cb => cb(snap(n)));
  const colRef = (n) => ({
    onSnapshot(cb) { listeners[n].push(cb); setTimeout(() => cb(snap(n)), 0); return () => { const i = listeners[n].indexOf(cb); if (i >= 0) listeners[n].splice(i, 1); }; },
    doc(id) { return { set: async (d) => { data[n].set(id, d); fire(n); }, delete: async () => { data[n].delete(id); fire(n); } }; }
  });
  const authInstance = {
    onAuthStateChanged(cb) { authCb = cb; setTimeout(() => cb(user), 0); },
    signInWithPopup: async () => { user = { uid: 'test', email: 'prueba@gmail.com' }; authCb(user); return { user }; },
    signInWithRedirect: async () => { throw new Error('stub'); },
    signOut: async () => { user = null; authCb(null); }
  };
  window.firebase = {
    initializeApp() {},
    auth: Object.assign(() => authInstance, { GoogleAuthProvider: function () {} }),
    firestore: () => ({ enablePersistence: () => Promise.resolve(), collection: () => ({ doc: () => ({ collection: colRef }) }) })
  };
  window.__stub = {
    datos: (n) => Object.fromEntries(data[n]),
    inyectar: (n, id, doc) => { data[n].set(id, doc); fire(n); },
    quitar: (n, id) => { data[n].delete(id); fire(n); }
  };
})();
