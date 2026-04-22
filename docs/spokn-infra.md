# Spokn Infra Diagram

Current architecture snapshot based on the `windows-test-app`, `@stt/core`, and `@stt/platform-windows` codepaths.

## System Overview

```mermaid
flowchart LR
    user["User"]
    focused["Focused external app<br/>target for text injection"]

    subgraph tauri["Tauri Desktop Shell"]
        tray["System tray"]
        shortcuts["Global shortcuts"]
        overlay["Floating recording overlay"]
        main["Main window"]
        inject["Rust text injection<br/>clipboard + Ctrl+V"]
    end

    subgraph ui["React UI"]
        left["Left panel<br/>record / upload / settings"]
        workspace["Workspace<br/>transcript / typing text / review"]
        debug["Debug + logs + model manager"]
        api["src/lib/api.ts<br/>HTTP + SSE client"]
        local["Browser storage<br/>localStorage snippets/vocab/shortcuts"]
    end

    subgraph backend["Local Node/Express Backend<br/>127.0.0.1:3001"]
        health["/api/health"]
        transcribe["/api/transcribe<br/>JSON or SSE partials"]
        models["/api/models/*<br/>catalog/register/download/recommend"]
        feedback["/api/feedback"]
        upload["/api/upload-recording"]
        temp["%TEMP%/stt-test-app-uploads"]
        pipe["src-node/pipeline.ts"]
    end

    subgraph core["@stt/core"]
        route["Routing + chooseModel"]
        run["transcribeFile()"]
        post["Post-processing<br/>formatting / correction / transcript shaping"]
        rules["Adaptive rules derivation"]
    end

    subgraph win["@stt/platform-windows"]
        adapter["MultiBackendWindowsAdapter"]
        adaptive["AdaptiveBackend<br/>optional ffmpeg-assisted preprocessing"]
        whisper["WhisperCppBackend"]
        store["WindowsModelStore"]
        fbstore["WindowsFeedbackStore"]
        device["Windows device profile"]
        binary["Binary manager"]
    end

    subgraph localfs["Local Windows Filesystem"]
        modeldir["%LOCALAPPDATA%/stt-platform-windows/models"]
        bindir["%LOCALAPPDATA%/stt-platform-windows/bin"]
        manifest["manifest.json"]
        weights["GGUF model files"]
        cli["whisper-cli.exe"]
    end

    user --> left
    user --> workspace
    tray --> main
    shortcuts --> main
    overlay --> main
    main --> left
    main --> workspace
    main --> debug
    workspace --> api
    left --> api
    debug --> api
    api --> health
    api --> transcribe
    api --> models
    api --> feedback
    api --> upload
    left --> local
    workspace --> local
    main --> inject
    inject --> focused

    upload --> temp
    transcribe --> pipe
    health --> pipe
    models --> pipe
    feedback --> pipe

    pipe --> device
    pipe --> route
    pipe --> run
    pipe --> rules
    rules --> fbstore
    run --> adapter
    route --> store
    adapter --> adaptive
    adaptive --> whisper
    adapter --> store
    pipe --> binary

    store --> modeldir
    modeldir --> manifest
    modeldir --> weights
    binary --> bindir
    bindir --> cli
    whisper --> cli
    whisper --> weights
    transcribe -. partial/final transcript .-> api
```

## Transcription Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant R as React UI
    participant A as API client
    participant E as Express backend
    participant P as pipeline.ts
    participant C as @stt/core
    participant W as Windows adapter
    participant X as whisper-cli.exe
    participant F as Feedback store

    U->>R: record / upload / file path
    R->>A: transcribeStreaming() or transcribe()
    A->>E: POST /api/transcribe
    alt uploaded audio
        E->>E: save file to %TEMP%
    end
    E->>P: runTranscription(...)
    P->>W: getAvailableModelIds()
    P->>C: chooseModel(...)
    P->>F: load adaptive feedback rules
    P->>C: transcribeFile(...)
    C->>W: transcribe via runtime adapter
    W->>X: run whisper-cli with model + audio
    X-->>W: JSON transcript output
    W-->>C: raw segments + confidences
    C-->>P: final transcript + metadata
    P-->>E: result + routing debug info
    alt streaming enabled
        E-->>A: SSE partial events
        E-->>A: SSE final event
    else one-shot
        E-->>A: JSON response
    end
    A-->>R: transcript + routing + timings
    R-->>U: transcript/debug panels
```

## Notes

- This is a fully local/offline architecture in normal transcription flow. There is no cloud STT service in the current path.
- The backend auto-initializes the correct `whisper-cli` binary variant at startup and stores models/binaries under `%LOCALAPPDATA%`.
- Feedback is persisted locally and turned into adaptive rules for later transcription requests.
- Tauri mainly provides native shell features: tray behavior, global shortcuts, floating overlay, and text injection into the focused app.
