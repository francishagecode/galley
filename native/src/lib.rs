//! Exposes Galley's Typst engine to the Electron main process. Work runs on
//! libuv's thread pool so the main process never blocks on a compile or a
//! page render.

use std::sync::Arc;

use galley_engine::Engine;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

#[napi(js_name = "Engine")]
pub struct JsEngine {
    engine: Arc<Engine>,
}

#[napi]
impl JsEngine {
    #[napi(constructor)]
    pub fn new(user_agent: String) -> Self {
        Self {
            engine: Arc::new(Engine::new(&user_agent)),
        }
    }

    /// Runs an engine command with JSON arguments; resolves to the JSON result.
    #[napi]
    pub fn invoke(&self, command: String, args: String) -> AsyncTask<Invoke> {
        AsyncTask::new(Invoke {
            engine: self.engine.clone(),
            command,
            args,
        })
    }

    /// Rasterizes a preview page named `<hash>-<width>.png`; resolves to null
    /// when the page isn't from a recent compile.
    #[napi]
    pub fn page_png(&self, name: String) -> AsyncTask<PagePng> {
        AsyncTask::new(PagePng {
            engine: self.engine.clone(),
            name,
        })
    }
}

pub struct Invoke {
    engine: Arc<Engine>,
    command: String,
    args: String,
}

impl Task for Invoke {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        self.engine
            .invoke_json(&self.command, &self.args)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

pub struct PagePng {
    engine: Arc<Engine>,
    name: String,
}

impl Task for PagePng {
    type Output = Option<Vec<u8>>;
    type JsValue = Option<Buffer>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.engine.page_png(&self.name))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(Buffer::from))
    }
}
