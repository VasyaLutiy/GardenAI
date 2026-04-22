import { registerRootComponent } from 'expo'
import React from 'react'
import { StatusBar } from 'expo-status-bar'
import MainScreen from './src/screens/MainScreen'

function App() {
  return (
    <>
      <StatusBar style="dark" />
      <MainScreen />
    </>
  )
}

registerRootComponent(App)
