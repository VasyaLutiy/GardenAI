// Re-export from eventBus to avoid Metro collision with the Node.js built-in 'events' module.
// All new code should import directly from './eventBus'.
export * from './eventBus'
