package com.armitorenk.pdfeditor;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local native object-editing engine plugin before the bridge starts.
        registerPlugin(PdfEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
