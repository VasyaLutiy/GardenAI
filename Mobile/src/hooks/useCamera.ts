import { useRef, useCallback } from 'react'
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera'

export function useCamera() {
  const cameraRef = useRef<CameraView>(null)
  const [permission, requestPermission] = useCameraPermissions()

  // Заменяет canvas.toDataURL() из браузерного App.jsx.
  // Возвращает локальный URI файла — передаётся напрямую в FormData.
  const takePhoto = useCallback(async (): Promise<string | null> => {
    if (!cameraRef.current) return null
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.8,
      base64: false,
    })
    return photo?.uri ?? null
  }, [])

  return {
    cameraRef,
    facing: 'back' as CameraType,
    hasPermission: permission?.granted ?? false,
    requestPermission,
    takePhoto,
  }
}
